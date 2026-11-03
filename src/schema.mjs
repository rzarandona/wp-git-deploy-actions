/** A strict validator for the subset of JSON Schema the request contracts use (unknown fields are always refused). */
function requireThat(condition, message) { if (!condition) throw new Error(message); }

export function validateSchema(value, rule, path = 'request') {
  if (rule.const !== undefined) requireThat(value === rule.const, `invalid ${path}`);
  if (rule.enum) requireThat(rule.enum.includes(value), `invalid ${path}`);
  if (rule.type === 'object') {
    requireThat(value !== null && typeof value === 'object' && !Array.isArray(value), `invalid ${path}`);
    for (const name of rule.required ?? []) requireThat(Object.hasOwn(value, name), `missing ${path}.${name}`);
    for (const [name, data] of Object.entries(value)) {
      requireThat(Object.hasOwn(rule.properties ?? {}, name), `unknown ${path} field ${name}`);
      validateSchema(data, rule.properties[name], `${path}.${name}`);
    }
  } else if (rule.type === 'array') {
    requireThat(Array.isArray(value) && value.length >= (rule.minItems ?? 0) && value.length <= (rule.maxItems ?? Infinity), `invalid ${path}`);
    value.forEach((item, i) => validateSchema(item, rule.items ?? {}, `${path}[${i}]`));
  } else if (rule.type === 'string') {
    requireThat(typeof value === 'string', `invalid ${path}`);
    if (rule.pattern) { const match = new RegExp(rule.pattern).exec(value); requireThat(match && match[0] === value, `invalid ${path}`); }
  } else if (rule.type === 'integer') requireThat(Number.isSafeInteger(value) && value >= (rule.minimum ?? -Infinity) && value <= (rule.maximum ?? Infinity), `invalid ${path}`);
  else if (rule.type === 'boolean') requireThat(typeof value === 'boolean', `invalid ${path}`);
  else requireThat(rule.type === undefined, `unsupported schema type at ${path}`);
}
