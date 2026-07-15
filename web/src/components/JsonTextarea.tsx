import { useEffect, useRef, useState } from 'react'
import type { JsonData } from './SettingsTreeEditor.js'

interface JsonTextareaProps {
  value: unknown
  onChange: (value: JsonData) => void
  /** Optional label shown above the textarea. */
  label?: string
}

/** Textarea that holds a JSON string. Parses on blur — if valid, calls onChange
 *  with the parsed value and clears the error. If invalid, shows the parse error
 *  inline and keeps the text so the user can fix it. External value changes
 *  (e.g. revert) re-serialize into the textarea when the field isn't focused. */
export default function JsonTextarea({ value, onChange, label }: JsonTextareaProps) {
  const [text, setText] = useState(() => JSON.stringify(value, null, 2))
  const [error, setError] = useState<string | null>(null)
  const focused = useRef(false)

  // Re-serialize when the external value changes and the field isn't focused.
  useEffect(() => {
    if (!focused.current) {
      setText(JSON.stringify(value, null, 2))
      setError(null)
    }
  }, [value])

  function handleBlur() {
    focused.current = false
    try {
      const parsed = JSON.parse(text)
      setError(null)
      onChange(parsed as JsonData)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div className="json-textarea">
      {label && <span className="field-label">{label}</span>}
      <textarea
        className="json-textarea-input"
        value={text}
        spellCheck={false}
        onChange={(e) => setText(e.target.value)}
        onFocus={() => {
          focused.current = true
        }}
        onBlur={handleBlur}
      />
      {error && <div className="json-textarea-error">{error}</div>}
    </div>
  )
}
