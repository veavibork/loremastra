import { isHexColor } from './utils.js'

interface ColorFieldProps {
  label: string
  value: string
  onChange: (value: string) => void
  /** When true, empty string is valid ("inherit"). Shows a × clear button. */
  allowEmpty?: boolean
}

/** Color picker with display-only hex text. For non-hex values (rgba, empty),
 *  the swatch falls back to #000000 and the text shows the raw value. */
export default function ColorField({ label, value, onChange, allowEmpty }: ColorFieldProps) {
  const swatchValue = isHexColor(value) ? value : '#000000'
  const displayText = value === '' ? 'inherit' : value

  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <div className="field-color-row">
        <input
          type="color"
          className="field-color-swatch"
          value={swatchValue}
          onChange={(e) => onChange(e.target.value)}
        />
        <span className="field-color-text">{displayText}</span>
        {allowEmpty && value !== '' && (
          <button
            type="button"
            className="field-color-clear"
            title="Clear (inherit)"
            onClick={() => onChange('')}
          >
            ×
          </button>
        )}
      </div>
    </label>
  )
}
