import catalog from "./fixtures/relay-a2ui-catalog.json";

/**
 * A local structural check of a card against Relay's A2UI catalog (copied
 * from Relay-Server staging server/src/data/a2ui/v0_9_1/catalogs/relay/v1):
 * known components, known and required properties, a root, and children
 * that exist. The server's full schema validation is the authority.
 */
type Schema = { properties?: Record<string, unknown>; required?: string[]; allOf?: Schema[] };
const components = (catalog as { components: Record<string, Schema> }).components;

function shape(name: string) {
  const schema = components[name]!;
  const parts = schema.allOf ?? [schema];
  const props = new Set<string>(["id", "component", "weight", "accessibility"]);
  const required = new Set<string>();
  for (const part of parts) {
    for (const key of Object.keys(part.properties ?? {})) props.add(key);
    for (const key of part.required ?? []) required.add(key);
  }
  return { props, required };
}

export function checkCard(list: ReadonlyArray<Record<string, unknown>>): string[] {
  const problems: string[] = [];
  const ids = new Set(list.map((c) => String(c.id)));
  if (!ids.has("root")) problems.push("no root component");
  for (const component of list) {
    const name = String(component.component);
    if (!components[name]) {
      problems.push(`${component.id}: unknown component ${name}`);
      continue;
    }
    const { props, required } = shape(name);
    for (const key of Object.keys(component)) if (!props.has(key)) problems.push(`${component.id}: ${name} has no property ${key}`);
    for (const key of required) if (!(key in component) && key !== "component" && key !== "id") problems.push(`${component.id}: ${name} needs ${key}`);
    const refs = [component.child, ...(Array.isArray(component.children) ? component.children : [])]
      .filter((ref): ref is string => typeof ref === "string");
    for (const ref of refs) if (!ids.has(ref)) problems.push(`${component.id}: child ${ref} does not exist`);
  }
  return problems;
}
