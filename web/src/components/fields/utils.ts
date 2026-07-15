/** True for solid 6-digit hex colors (#rrggbb). rgba()/hsl() etc. are not representable
 *  by a native <input type="color"> and must stay text fields. */
export function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value)
}
