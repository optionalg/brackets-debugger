/*
 * Copyright (c) 2012 Adobe Systems Incorporated. All rights reserved.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a
 * copy of this software and associated documentation files (the "Software"),
 * to deal in the Software without restriction, including without limitation
 * the rights to use, copy, modify, merge, publish, distribute, sublicense,
 * and/or sell copies of the Software, and to permit persons to whom the
 * Software is furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
 * FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
 * DEALINGS IN THE SOFTWARE.
 *
 */

/*jslint vars: true, plusplus: true, devel: true, browser: true, nomen: true, regexp: true, indent: 4, maxerr: 50 */
/*global define, brackets, $ */

define(function (require, exports, module) {
	'use strict';

	var Inspector = brackets.getModule("LiveDevelopment/Inspector/Inspector");
	var ScriptAgent = brackets.getModule("LiveDevelopment/Agents/ScriptAgent");
	var Trace = require("Trace");

	var _breakpoints = {};

	var nextNumber = 1;

	var $exports = $(exports);

	function _lineLengths(source) {
		var lines = [];
		var index = source.search("\n");
		while (index >= 0) {
			lines.push(index + 1);
			source = source.substr(index + 1);
			index = source.search("\n");
		}
		lines.push(source.length);
		return lines;
	}

	function _updateOffset(location, diff, lines) {
		var i, offset = location.offset;
		for (i in diff) {
			if (i > offset) {
				break;
			}
			offset += diff[i];
		}
		if (offset !== location.offset) {
			location.offset = offset;
			var x = 0;
			for (i in lines) {
				x += lines[i];
				if (x > offset) {
					var columnNumber = offset - (x - lines[i]);
					if (location.lineNumber !== i || location.columnNumber !== columnNumber) {
						location.lineNumber = parseInt(i, 10);
						location.columnNumber = columnNumber;
					}
					break;
				}
			}
		}
	}

	function _resolveVariable(value, constraints, cache, depth) {
		if (! cache) { cache = {}; }
		if (! depth) { depth = 0; }
		
		var result = new $.Deferred();

		var ignore = !value || (value.type == "object" && (value.className == "Window" || value.className == "Document"));
		if (ignore || ! value.objectId) {
			result.resolve(value);
		}
		else if (cache[value.objectId]) {
			result.resolve(cache[value.objectId]);
		}
		else {
			cache[value.objectId] = value;
			if (! constraints.maxDepth || depth < constraints.maxDepth) {
				Inspector.Runtime.getProperties(value.objectId, true, function (res) {
					var i, info;
					var pending = [];
					var resolved = value.value = {};

					var preferredKeys = null;
					if (value.subtype === "node") {
						preferredKeys = ["nodeType", "nodeName", "id", "className", "dataset", "attributes"];
					}

					if (preferredKeys) {
						var byName = {};
						for (i = 0; i < res.result.length; i++) {
							if (preferredKeys.indexOf(res.result[i].name) === -1) { continue; }
							info = res.result[i];
							resolved[info.name] = info.value;
							pending.push(_resolveVariable(info.value, {}, cache, depth + 1));
						}
						resolved[""] = { special: "abbreviated" };
					}
					else {
						var used = 0;
						for (i = 0; i < res.result.length; i++) {
							info = res.result[i];
							if (! info.enumerable) { continue; }
							used++;
							if (constraints.maxChildren && used > constraints.maxChildren) {
								resolved[""] = { special: "abbreviated" };
								break;
							}
							resolved[info.name] = info.value;
							pending.push(_resolveVariable(info.value, constraints, cache, depth + 1));
						}
					}
	
					$.when.apply(null, pending).done(function () {
						if (value.type === "function") {
							Inspector.Debugger.getFunctionDetails(value.objectId, function (res) {
								value.details = res.details;
								result.resolve(value);
							});
						}
						else {
							result.resolve(value);
						}
					});
				});
			} else {
				result.resolve(value);
			}
		}

		return result.promise();
	}
	
	// Breakpoints Class
	function Breakpoint(location, condition, type) {
		if (type === undefined) type = "user";
		this.location = location;
		this.condition = condition;
		this.type = type;
		this.trace = [];

		this.number = nextNumber++;
		this.active = false;

		if (type !== "user") {
			this.haltOnPause = false;
			this.traceOnPause = true;
		} else {
			this.haltOnPause = true;
			this.traceOnPause = false;
		}
	}

	// Breakpoints Methods
	Breakpoint.prototype = {

		// set the breakpoint in the Inspector
		set: function () {
			_breakpoints[this.number] = this;
			this.active = true;
			
			var self = this;
			var l = this.location;
			Inspector.Debugger.setBreakpointByUrl(l.lineNumber, l.url, l.urlRegex, l.columnNumber, this.condition, function (res) {
				// res = {breakpointId, locations}
				self.id = res.breakpointId;
				self.resolvedLocations = [];
				$(self).triggerHandler("set", { breakpoint: self });
				self._addResolvedLocations(res.locations);
			});
		},

		// update the location of the breakpoint as an effect of a source code edit
		// this function is used to keep breakpoints in sync with the debugger
		// this function si not used to update the location of the breakpoint in the debugger
		updateLocation: function (lineNumber, columnNumber) {
			this.location.lineNumber = lineNumber;
			this.location.columnNumber = columnNumber;
			$(this).triggerHandler("move", { breakpoint: this, location: location });
		},

		// remove the breakpoint in the Inspector
		remove: function () {
			delete _breakpoints[this.number];
			this.active = false;
			
			var self = this;
			Inspector.Debugger.removeBreakpoint(this.id, function (res) {
				// res = {}
				$(self).triggerHandler("remove", { breakpoint: self });
				delete self.id;
				delete self.resolvedLocations;
			});
		},

		// toggle the breakpoint
		toggle: function () {
			if (this.active) {
				this.remove();
			} else {
				this.set();
			}
		},

		// matches the breakpoint's type, location, and condition
		matches: function (location, condition) {
			return this.location.url === location.url &&
				this.location.urlRegex === location.urlRegex &&
				this.location.lineNumber === location.lineNumber &&
				this.location.columnNumber === location.columnNumber &&
				this.condition === condition;
		},

		// matches the breakpoint's resolved locations
		matchesResolved: function (location) {
			for (var i in this.resolvedLocations) {
				var l = this.resolvedLocations[i];
				if (l.scriptId === location.scriptId &&
					l.lineNumber === location.lineNumber &&
					(location.columnNumber === undefined || l.columnNumber === location.columnNumber)) {
					return true;
				}
			}
			return false;
		},

		// add a resolved location
		_addResolvedLocations: function (locations) {
			var $this = $(this), i, location;
			for (i in locations) {
				location = locations[i];
				if (this.matchesResolved(location)) continue;
				this.resolvedLocations.push(location);
				$this.triggerHandler("resolve", { breakpoint: this, location: location });
			}
		},

		// reset the trace
		_reset: function () {
			this.trace = [];
		},

		// trigger paused
		triggerPaused: function (callFrames) {
			if (! this.traceOnPause) { return; }
			this.trace.push(new Trace.Trace(this.type, callFrames));
		},

		traceForEvent: function (event) {
			if (! event || ! this.trace) { return; }
			var trace = this.trace[this.trace.length - 1];
			if (! trace.childOf(event.callFrames)) { return; }
			return trace;
		},
	
		resolveVariable: function (variable, constraints) {
			if (! this.trace) { return; }
			
			var result = new $.Deferred();

			var trace = this.trace[this.trace.length - 1];
			if (! trace || trace.callFrames.length === 0) { return result.reject(); }
			
			var callFrameIndex = 0;
			var callFrame = trace.callFrames[callFrameIndex];

			if (variable === "this" && callFrame.this) {
				var value = callFrame.this;
				value.scope = "this";
				_resolveVariable(value, constraints).done(result.resolve);
			}
			else {
				trace.resolveCallFrame(callFrameIndex).done(function () {
					var scopeChain = callFrame.scopeChain;
					for (var i = 0; i < scopeChain.length; i++) {
						var vars = scopeChain[i].resolved;
						if (vars && vars[variable]) {
							var value = vars[variable];
							value.scope = scopeChain[i].type;
							_resolveVariable(value, constraints).done(result.resolve);
							return;
						}
					}
					result.reject();
				});
			}

			return result.promise();
		}
	};

	// Inspector Event: breakpoint resolved
	function _onBreakpointResolved(res) {
		// res = {breakpointId, location}
		var breakpoint = findById(res.breakpointId);
		if (breakpoint) {
			breakpoint._addResolvedLocations([res.location]);
		}
	}

	// Inspector Event: Debugger.globalObjectCleared
	function _onGlobalObjectCleared() {
		// Reset the trace array for all tracepoints
		for (var i in _breakpoints) {
			_breakpoints[i]._reset();
		}
	}

	// Inspector connected
	function _onConnect() {
		Inspector.Debugger.enable();
		for (var i in _breakpoints) {
			var b = _breakpoints[i];
			if (b.active) {
				b.set();
			}
		}
	}

	function _onSetScripSource(res) {
		// res = {callFrames, result, script, scriptSource, diff}
		var lines = _lineLengths(res.scriptSource);
		
		for (var i in _breakpoints) {
			var b = _breakpoints[i];
			for (var j in b.resolvedLocations) {
				_updateOffset(b.resolvedLocations[j], res.diff, lines);
			}
		}
	}

	// Find resolved breakpoints
	function findResolved(location) {
		if (!location.scriptId) {
			location.scriptId = ScriptAgent.scriptForURL(location.url).scriptId;
		}
		var result = [];
		for (var i in _breakpoints) {
			var b = _breakpoints[i];
			if (b.matchesResolved(location)) {
				result.push(b);
			}
		}
		return result;
	}

	// Find breakpoints
	function find(location, condition) {
		for (var i in _breakpoints) {
			var b = _breakpoints[i];
			if (b.matches(location, condition)) {
				return b;
			}
		}
	}

	function findById(id) {
		for (var i in _breakpoints) {
			var b = _breakpoints[i];
			if (b.id === id) {
				return b;
			}
		}
	}

	// Init
	function init() {
		Inspector.on("connect", _onConnect);
		Inspector.on("Debugger.breakpointResolved", _onBreakpointResolved);
		Inspector.on("Debugger.globalObjectCleared", _onGlobalObjectCleared);
		Inspector.on("ScriptAgent.setScriptSource", _onSetScripSource);
		if (Inspector.connected()) _onConnect();
	}

	// Unload
	function unload() {
		Inspector.off("connect", _onConnect);
		Inspector.off("Debugger.breakpointResolved", _onBreakpointResolved);
		Inspector.off("Debugger.globalObjectCleared", _onGlobalObjectCleared);
		Inspector.off("ScriptAgent.setScriptSource", _onSetScripSource);
		$exports.off();
	}

	exports.init = init;
	exports.unload = unload;
	exports.find = find;
	exports.findById = findById;
	exports.findResolved = findResolved;
	exports.Breakpoint = Breakpoint;
});
