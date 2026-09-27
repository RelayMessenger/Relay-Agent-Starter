// The Relay server's own component check (Relay-Server staging, server/src/
// a2ui.ts checkComponents, 935deb1), run before anything is sent. The server
// applies a card's messages one by one: a createSurface it accepts beside
// components it refuses leaves an empty card that the app shows as a spinner,
// and the refusal arrives after reply has ended the turn. Checking here, with
// the same schemas and the same validator, sends the errors to the model
// while it can still fix them.
import { dereference, validate, type OutputUnit, type Schema } from "@cfworker/json-schema";

import commonTypes from "./data/a2ui/common_types.json";
import relayCatalog from "./data/a2ui/relay-catalog-v1.json";

interface CatalogDocument {
  $id: string;
  components: Record<string, unknown>;
  functions: Record<string, unknown>;
}

const schema = (value: unknown): Schema => value as Schema;
// common_types.json names functions through a sibling "catalog.json".
const CATALOG_JSON_ID = "https://a2ui.org/specification/v0_9/catalog.json";

let lookup: Record<string, Schema | boolean> | null = null;
function catalogLookup(): Record<string, Schema | boolean> {
  if (lookup) return lookup;
  const catalog = relayCatalog as CatalogDocument;
  const next = dereference(schema(structuredClone(commonTypes)));
  const own = structuredClone(catalog);
  const asCatalogJson = { ...structuredClone(catalog), $id: CATALOG_JSON_ID };
  dereference(schema(own), next);
  dereference(schema(asCatalogJson), next);
  // The validator skips a subschema whose key is a keyword (the function
  // named `required`), so functions are registered by hand.
  for (const [document, id] of [[own, catalog.$id], [asCatalogJson, CATALOG_JSON_ID]] as const) {
    for (const [name, definition] of Object.entries(document.functions)) {
      next[`${id}#/functions/${name}`] ??= schema(definition);
    }
  }
  return lookup = next;
}

const COMPOSITE = new Set(["$ref", "oneOf", "anyOf", "allOf", "items", "prefixItems", "properties", "const", "not", "false", "unevaluatedProperties"]);
/** The server's one readable line for a schema failure. */
function schemaIssue(errors: OutputUnit[]): { path: string; message: string } {
  const byDepth = (list: OutputUnit[]) => [...list].sort((left, right) =>
    right.instanceLocation.length - left.instanceLocation.length)[0];
  const leaf = byDepth(errors.filter((error) => !COMPOSITE.has(error.keyword)));
  const pointer = (location: string) => location.replace(/^#/u, "");
  if (leaf) {
    const missing = leaf.keyword === "required" ? /required property "([^"]+)"/u.exec(leaf.error)?.[1] : undefined;
    return { message: leaf.error, path: pointer(leaf.instanceLocation) + (missing === undefined ? "" : `/${missing}`) };
  }
  const unknown = errors.find((error) => error.keyword === "false");
  if (unknown) return { message: "This property is not allowed here.", path: pointer(unknown.instanceLocation) };
  const deepest = byDepth(errors);
  return { message: deepest?.error ?? "It does not match the A2UI v0.9.1 schema.", path: pointer(deepest?.instanceLocation ?? "#") };
}

const ACTION_SHAPES = 'An action is {"event": {"name": "next", "context": {"number": 2}}} or '
  + '{"functionCall": {"call": "openUrl", "args": {"url": "https://..."}}}; each context value is a string, a number, '
  + 'true or false, a list, or {"path": "/name"}, never another object.';

/** Fits a card's full-width button on the narrowest iPhone at 16 pt. */
export const MAX_BUTTON_LABEL = 24;

export interface CardIssue {
  path: string;
  message: string;
}

/**
 * Every problem with a card's components: each against Relay's catalog, as
 * the server checks it, plus what the app needs to draw anything at all (a
 * "root", and children that exist). Empty when the card is good.
 */
export function cardIssues(components: ReadonlyArray<Record<string, unknown>>): CardIssue[] {
  const catalog = relayCatalog as CatalogDocument;
  const issues: CardIssue[] = [];
  const ids = new Set(components.map((component) => component.id));
  if (!ids.has("root")) issues.push({ message: 'No component has id "root"; the card has nothing to show.', path: "/components" });
  for (const [index, component] of components.entries()) {
    const name = component.component;
    if (typeof name !== "string" || !Object.hasOwn(catalog.components, name)) {
      issues.push({ message: `"${String(name)}" is not a Relay card component.`, path: `/components/${index}/component` });
      continue;
    }
    const result = validate(component, schema({ $ref: `${catalog.$id}#/components/${name}` }), "2020-12", catalogLookup(), false);
    if (!result.valid) {
      const issue = schemaIssue(result.errors);
      // The schema's words for a bad action don't say what a good one is.
      const hint = issue.path.startsWith("/action") ? ` ${ACTION_SHAPES}` : "";
      issues.push({ message: issue.message + hint, path: `/components/${index}${issue.path}` });
    }
    // Tania's own rule, not the server's: Relay's app never wraps a button
    // label, so a long one is cut off at the card's edge.
    if (name === "Button") {
      const label = components.find((other) => other.id === component.child);
      const text = typeof label?.text === "string" ? label.text : "";
      if (text.length > MAX_BUTTON_LABEL) {
        issues.push({
          message: `The button label "${text}" is ${text.length} characters; keep it to ${MAX_BUTTON_LABEL} or fewer, a short action without a price.`,
          path: `/components/${components.indexOf(label!)}/text`,
        });
      }
    }
    const tabs = Array.isArray(component.tabs) ? component.tabs.map((tab: { child?: unknown }) => tab?.child) : [];
    const children = [component.child, ...(Array.isArray(component.children) ? component.children : []), ...tabs];
    for (const child of children) {
      if (typeof child === "string" && !ids.has(child)) {
        issues.push({ message: `"${child}" is not the id of any component in this card.`, path: `/components/${index}` });
      }
    }
  }
  return issues;
}
