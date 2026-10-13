/* 𓁹𓁹: what a tool may be given, checked.
 *
 * Every tool describes its input, and the answer it gives, with JSON Schema.
 * This checks a value against one before the tool sees it: in the browser,
 * where s.js offers a page's tools to agents (WebMCP), and on the MCP server,
 * so the same mistake gets the same answer, in the site's words, wherever an
 * agent makes it. The tests hold every tool's answers to its output schema
 * with it too.
 *
 * It knows the part of JSON Schema the tools use: type (one, or a list),
 * enum, const, minimum, maximum, minLength, maxLength, pattern, properties,
 * required, additionalProperties, items, minItems, maxItems and anyOf, beside
 * the keywords that only describe (title, description, default, examples,
 * contentEncoding, contentMediaType). `unknown` lists any other keyword a
 * schema uses, which the tests refuse: a keyword this would silently skip is a
 * check nobody makes.
 *
 * A classic script with no dependencies, defining `AgentSchema`.
 */
(function (root) {
  "use strict";

  var CHECKED = ["type", "enum", "const", "minimum", "maximum", "minLength", "maxLength", "pattern", "properties",
    "required", "additionalProperties", "items", "minItems", "maxItems", "anyOf"];
  var DESCRIBING = ["title", "description", "default", "examples", "contentEncoding", "contentMediaType"];
  var NAMES = { string: "text", number: "a number", integer: "a whole number", boolean: "true or false", object: "an object", array: "a list", "null": "null" };
  var LONG_ENUM = 8;

  /* "a", "a or b", "a, b or c". */
  function either(words) {
    return words.length < 2 ? words.join("") : words.slice(0, -1).join(", ") + " or " + words[words.length - 1];
  }
  function both(words) {
    return words.length < 2 ? words.join("") : words.slice(0, -1).join(", ") + " and " + words[words.length - 1];
  }
  /* A value as a message shows it: plain words bare, anything else as JSON. */
  function shown(value) {
    return typeof value === "string" && /^[\w./+-]+$/.test(value) ? value : JSON.stringify(value);
  }
  function count(n) {
    return Number(n).toLocaleString("en-US");
  }

  function isType(type, value) {
    switch (type) {
      case "string": return typeof value === "string";
      case "number": return typeof value === "number" && isFinite(value);
      case "integer": return typeof value === "number" && isFinite(value) && Math.floor(value) === value;
      case "boolean": return typeof value === "boolean";
      case "null": return value === null;
      case "array": return Array.isArray(value);
      case "object": return value !== null && typeof value === "object" && !Array.isArray(value);
      default: return false;
    }
  }
  function types(schema) {
    return schema.type == null ? [] : [].concat(schema.type);
  }

  function same(a, b) {
    return a === b || JSON.stringify(a) === JSON.stringify(b);
  }

  /**
   * The first thing wrong with a value, or null.
   * @param {Object} schema
   * @param {*} value
   * @param {string} label How the message names the value: a property's path.
   */
  function problem(schema, value, label) {
    var kinds = types(schema), i;
    if (kinds.length && !kinds.some(function (type) { return isType(type, value); })) {
      return label + " must be " + either(kinds.map(function (type) { return NAMES[type] || type; }));
    }
    if (schema.anyOf) {
      var reasons = [];
      for (i = 0; i < schema.anyOf.length; i++) {
        var reason = problem(schema.anyOf[i], value, label);
        if (!reason) { reasons = null; break; }
        reasons.push(reason);
      }
      if (reasons) {
        /* The reason from the branch whose type fits, which says what is
           actually wrong; failing that, what any branch would take. */
        var fitting = schema.anyOf.map(function (branch, at) { return types(branch).some(function (type) { return isType(type, value); }) ? reasons[at] : null; })
          .filter(Boolean)[0];
        return fitting || reasons[0];
      }
    }
    if ("const" in schema && !same(schema["const"], value)) return label + " must be " + shown(schema["const"]);
    if (schema["enum"] && !schema["enum"].some(function (option) { return same(option, value); })) {
      var options = schema["enum"].map(shown);
      return options.length > LONG_ENUM
        ? label + " must be one of the " + options.length + " values the schema lists, such as " + either(options.slice(0, 3))
        : label + " must be " + either(options);
    }
    if (typeof value === "number") {
      var low = schema.minimum, high = schema.maximum;
      if ((low != null && value < low) || (high != null && value > high)) {
        return label + " must be " + (low != null && high != null ? "between " + low + " and " + high : low != null ? "at least " + low : "at most " + high);
      }
    }
    if (typeof value === "string") {
      if (schema.minLength === 1 && !value.length) return label + " must not be empty";
      if (schema.minLength != null && value.length < schema.minLength) return label + " must be at least " + count(schema.minLength) + " characters long";
      if (schema.maxLength != null && value.length > schema.maxLength) return label + " must be at most " + count(schema.maxLength) + " characters long";
      if (schema.pattern != null && !new RegExp(schema.pattern).test(value)) return label + " must match " + schema.pattern;
    }
    if (Array.isArray(value)) {
      if (schema.minItems != null && value.length < schema.minItems) return label + " must have at least " + count(schema.minItems) + " items";
      if (schema.maxItems != null && value.length > schema.maxItems) return label + " must have at most " + count(schema.maxItems) + " items";
      if (schema.items) {
        for (i = 0; i < value.length; i++) {
          var wrong = problem(schema.items, value[i], label + "[" + i + "]");
          if (wrong) return wrong;
        }
      }
    }
    if (isType("object", value)) return objectProblem(schema, value, label);
    return null;
  }

  function objectProblem(schema, value, label) {
    var properties = schema.properties || {}, prefix = label ? label + "." : "", key, i;
    var required = schema.required || [];
    for (i = 0; i < required.length; i++) {
      if (value[required[i]] === undefined) return prefix + required[i] + " is required";
    }
    for (key in value) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      if (Object.prototype.hasOwnProperty.call(properties, key)) {
        var wrong = problem(properties[key], value[key], prefix + key);
        if (wrong) return wrong;
      } else if (schema.additionalProperties === false) {
        var names = Object.keys(properties);
        return "unknown " + (label ? "field " + prefix + key + ": " + label + " takes " : "input " + key + ": this tool takes ") +
          (names.length ? both(names) : "nothing");
      } else if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
        var extra = problem(schema.additionalProperties, value[key], prefix + key);
        if (extra) return extra;
      }
    }
    return null;
  }

  /* Every keyword a schema uses that this neither checks nor counts as
     description, each with where it is. */
  function unknown(schema, at, found) {
    found = found || [];
    at = at || "schema";
    if (!schema || typeof schema !== "object") return found;
    Object.keys(schema).forEach(function (key) {
      if (CHECKED.indexOf(key) < 0 && DESCRIBING.indexOf(key) < 0) found.push(at + "." + key);
    });
    Object.keys(schema.properties || {}).forEach(function (key) { unknown(schema.properties[key], at + ".properties." + key, found); });
    if (schema.items) unknown(schema.items, at + ".items", found);
    if (schema.additionalProperties && typeof schema.additionalProperties === "object") unknown(schema.additionalProperties, at + ".additionalProperties", found);
    (schema.anyOf || []).forEach(function (branch, i) { unknown(branch, at + ".anyOf[" + i + "]", found); });
    return found;
  }

  root.AgentSchema = {
    /**
     * Check a tool's input, or answer, against its schema.
     * @param {Object} schema The tool's input (or output) schema, an object schema.
     * @param {*} value
     * @returns {string|null} What is wrong, in the site's words, or null.
     */
    check: function (schema, value) {
      if (!isType("object", value)) return "the input must be an object";
      return problem(schema || { type: "object" }, value, "");
    },
    unknown: function (schema) { return unknown(schema); }
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
