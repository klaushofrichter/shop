/**
 * Request validation against Printful's pinned v2 OpenAPI document
 * (docs/design/14 §7.1). Printful silently ignores fields it doesn't know, so
 * the mock is the only place a typo such as `orientaton` shows: here every
 * object that is a value (a body, a property, an array item) is closed with
 * `unevaluatedProperties: false`. Objects inside allOf/oneOf stay open, so the
 * branches of a composition can add up. Fields marked readOnly (response-only)
 * are never required in a request.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import Ajv2019, { type ValidateFunction } from 'ajv/dist/2019';

type Schema = Record<string, unknown>;

const SPEC_FILE = path.join(__dirname, '..', 'spec', 'printful-v2.openapi.json');

export class PrintfulSpec {
  private readonly doc: Schema;
  private readonly ajv: Ajv2019;
  private readonly cache = new Map<string, ValidateFunction | null>();

  constructor(file = SPEC_FILE) {
    this.doc = JSON.parse(readFileSync(file, 'utf8')) as Schema;
    this.ajv = new Ajv2019({ strict: false, allErrors: true, validateFormats: false });
    const components = (this.doc.components as Schema)?.schemas as Record<string, Schema>;
    const strict: Record<string, Schema> = {};
    for (const [name, s] of Object.entries(components)) strict[name] = this.close(s, false);
    this.ajv.addSchema({ $id: 'printful', components: { schemas: strict } });
  }

  /** The pinned spec's version, for reports. */
  get version(): string {
    return String((this.doc.info as Schema).version);
  }

  /**
   * Validate a request body for `method` and a concrete `path` (e.g.
   * /v2/shipping-rates). Returns error messages; empty when valid or when the
   * operation takes no JSON body.
   */
  validateRequest(method: string, concretePath: string, body: unknown): string[] {
    const key = `${method.toLowerCase()} ${this.template(concretePath) ?? concretePath}`;
    if (!this.cache.has(key)) this.cache.set(key, this.compile(method.toLowerCase(), this.template(concretePath)));
    const validate = this.cache.get(key);
    if (!validate) return [];
    if (validate(body)) return [];
    return (validate.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message}${e.params && 'unevaluatedProperty' in e.params ? `: ${String(e.params.unevaluatedProperty)}` : ''}`);
  }

  /** Is this a path and method the spec knows? */
  knows(method: string, concretePath: string): boolean {
    const t = this.template(concretePath);
    return !!t && !!((this.doc.paths as Schema)[t] as Schema)[method.toLowerCase()];
  }

  private template(concrete: string): string | undefined {
    const paths = Object.keys(this.doc.paths as Schema);
    const p = concrete.replace(/\?.*$/, '');
    if (paths.includes(p)) return p;
    return paths.find((t) => new RegExp(`^${t.replace(/\{[^}]+\}/g, '[^/]+')}$`).test(p));
  }

  private compile(method: string, template: string | undefined): ValidateFunction | null {
    if (!template) return null;
    const op = ((this.doc.paths as Schema)[template] as Schema)?.[method] as Schema | undefined;
    let rb = op?.requestBody as Schema | undefined;
    rb = rb && this.deref(rb);
    const schema = ((rb?.content as Schema)?.['application/json'] as Schema)?.schema as Schema | undefined;
    if (!schema) return null;
    return this.ajv.compile(this.close(schema, true));
  }

  private deref(s: Schema): Schema {
    let cur = s;
    for (let i = 0; i < 10 && typeof cur.$ref === 'string'; i++) {
      cur = (cur.$ref as string)
        .slice(2)
        .split('/')
        .reduce<Schema>((o, k) => o[k] as Schema, this.doc);
    }
    return cur;
  }

  private objectLike(s: Schema): boolean {
    const t = typeof s.$ref === 'string' ? this.deref(s) : s;
    return t.type === 'object' || !!t.properties || ['allOf', 'oneOf', 'anyOf'].some((k) => Array.isArray(t[k]) && (t[k] as Schema[]).some((x) => this.objectLike(x)));
  }

  /** Rewrite refs into the strict components; close objects in value positions. */
  private close(s: Schema, valuePosition: boolean): Schema {
    if (!s || typeof s !== 'object') return s;
    if (typeof s.$ref === 'string') {
      const ref = { $ref: `printful${s.$ref}` };
      return valuePosition && this.objectLike(s) ? { allOf: [ref], unevaluatedProperties: false } : ref;
    }
    const out: Schema = { ...s };
    // Response-only fields (readOnly) are never required in a request.
    if (Array.isArray(s.required) && s.properties) {
      const props = s.properties as Record<string, Schema>;
      out.required = (s.required as string[]).filter((k) => !props[k]?.readOnly);
    }
    if (s.properties) {
      out.properties = Object.fromEntries(Object.entries(s.properties as Record<string, Schema>).map(([k, v]) => [k, this.close(v, true)]));
    }
    if (s.items) out.items = this.close(s.items as Schema, true);
    if (s.additionalProperties && typeof s.additionalProperties === 'object') out.additionalProperties = this.close(s.additionalProperties as Schema, true);
    for (const k of ['allOf', 'oneOf', 'anyOf'] as const) {
      if (Array.isArray(s[k])) out[k] = (s[k] as Schema[]).map((x) => this.close(x, false));
    }
    if (valuePosition && this.objectLike(s) && s.additionalProperties === undefined) out.unevaluatedProperties = false;
    return out;
  }
}
