import type { JsonData } from './SettingsTreeEditor.js'
import type { PlayTabSettings } from './PlayTabSettings.js'
import NumberField from './fields/NumberField.js'
import TextField from './fields/TextField.js'
import CheckboxField from './fields/CheckboxField.js'
import ColorField from './fields/ColorField.js'
import './fields/fields.css'

interface PlayTabFormProps {
  value: JsonData
  onChange: (value: JsonData) => void
}

export default function PlayTabForm({ value, onChange }: PlayTabFormProps) {
  const s = value as unknown as PlayTabSettings

  function update(patch: Partial<PlayTabSettings>) {
    onChange({ ...s, ...patch } as unknown as JsonData)
  }

  return (
    <div className="form-section">
      <NumberField
        label="Font size (px)"
        value={s.fontSize}
        onChange={(v) => update({ fontSize: v ?? 16 })}
        step={1}
        min={10}
        max={32}
      />

      <fieldset className="form-palette">
        <legend>Labels</legend>
        <CheckboxField
          label="Show user label"
          checked={s.showUserLabel}
          onChange={(showUserLabel) => update({ showUserLabel })}
        />
        <CheckboxField
          label="Show editor label"
          checked={s.showEditorLabel}
          onChange={(showEditorLabel) => update({ showEditorLabel })}
        />
        <CheckboxField
          label="Show author label"
          checked={s.showAuthorLabel}
          onChange={(showAuthorLabel) => update({ showAuthorLabel })}
        />
        <TextField
          label="User label"
          value={s.userLabel}
          onChange={(userLabel) => update({ userLabel })}
        />
        <TextField
          label="Editor label"
          value={s.editorLabel}
          onChange={(editorLabel) => update({ editorLabel })}
        />
        <TextField
          label="Author label"
          value={s.authorLabel}
          onChange={(authorLabel) => update({ authorLabel })}
        />
        <CheckboxField
          label="Italicize editor"
          checked={s.italicizeEditor}
          onChange={(italicizeEditor) => update({ italicizeEditor })}
        />
      </fieldset>

      <fieldset className="form-palette">
        <legend>Text colors</legend>
        <ColorField
          label="User text color"
          value={s.userTextColor}
          onChange={(userTextColor) => update({ userTextColor })}
          allowEmpty
        />
        <ColorField
          label="Agent text color"
          value={s.agentTextColor}
          onChange={(agentTextColor) => update({ agentTextColor })}
          allowEmpty
        />
      </fieldset>

      <fieldset className="form-palette">
        <legend>Bubbles</legend>
        <CheckboxField
          label="User bubble enabled"
          checked={s.userBubbleEnabled}
          onChange={(userBubbleEnabled) => update({ userBubbleEnabled })}
        />
        <CheckboxField
          label="Agent bubble enabled"
          checked={s.agentBubbleEnabled}
          onChange={(agentBubbleEnabled) => update({ agentBubbleEnabled })}
        />
        <ColorField
          label="User bubble color"
          value={s.userBubbleColor}
          onChange={(userBubbleColor) => update({ userBubbleColor })}
        />
        <ColorField
          label="Agent bubble color"
          value={s.agentBubbleColor}
          onChange={(agentBubbleColor) => update({ agentBubbleColor })}
        />
      </fieldset>
    </div>
  )
}
