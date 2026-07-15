interface NumberFieldProps {
  label: string
  value: number | null
  onChange: (value: number | null) => void
  step?: number
  min?: number
  max?: number
  placeholder?: string
}

/** Number input with label. Blank → null (for optional numeric fields). */
export default function NumberField({
  label,
  value,
  onChange,
  step,
  min,
  max,
  placeholder,
}: NumberFieldProps) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <input
        type="number"
        className="field-input field-input-num"
        value={value ?? ''}
        step={step}
        min={min}
        max={max}
        placeholder={placeholder}
        onChange={(e) => {
          const v = e.target.value
          onChange(v === '' ? null : Number(v))
        }}
      />
    </label>
  )
}
