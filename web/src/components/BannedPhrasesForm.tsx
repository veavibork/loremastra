import type { JsonData } from './SettingsTreeEditor.js'
import './fields/fields.css'

interface BannedPhrasesFormProps {
  value: JsonData
  onChange: (value: JsonData) => void
}

/** Editable string list for the banned-phrases settings space.
 *  value is string[] cast through JsonData. */
export default function BannedPhrasesForm({ value, onChange }: BannedPhrasesFormProps) {
  const phrases = (value as unknown as string[]) ?? []

  function update(next: string[]) {
    onChange(next as unknown as JsonData)
  }

  function editAt(index: number, text: string) {
    const next = [...phrases]
    next[index] = text
    update(next)
  }

  function removeAt(index: number) {
    update(phrases.filter((_, i) => i !== index))
  }

  function add() {
    update([...phrases, ''])
  }

  return (
    <div className="form-section">
      <ul className="banned-phrases-list">
        {phrases.map((phrase, i) => (
          <li key={i} className="banned-phrases-row">
            <input
              type="text"
              className="field-input field-input-text"
              value={phrase}
              onChange={(e) => editAt(i, e.target.value)}
              placeholder="Phrase to ban…"
            />
            <button
              type="button"
              className="banned-phrases-remove"
              title="Remove"
              onClick={() => removeAt(i)}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
      <button type="button" className="banned-phrases-add" onClick={add}>
        + Add phrase
      </button>
    </div>
  )
}
