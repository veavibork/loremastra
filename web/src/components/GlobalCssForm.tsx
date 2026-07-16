import type { JsonData } from './SettingsTreeEditor.js'
import type { GlobalCssColors, GlobalCssSettings } from '../lib/global-css-settings.js'
import NumberField from './fields/NumberField.js'
import ColorField from './fields/ColorField.js'
import TextField from './fields/TextField.js'
import './fields/fields.css'

interface GlobalCssFormProps {
  value: JsonData
  onChange: (value: JsonData) => void
}

/** Fields that use rgba (not solid hex) — must be TextField, not ColorField. */
const RGBA_FIELDS: Record<keyof GlobalCssColors, boolean> = {
  text: false,
  textH: false,
  bg: false,
  border: false,
  codeBg: false,
  accent: false,
  accentBg: true,
  accentBorder: true,
}

function ColorRow({
  label,
  colorKey,
  colors,
  onChange,
}: {
  label: string
  colorKey: keyof GlobalCssColors
  colors: GlobalCssColors
  onChange: (next: GlobalCssColors) => void
}) {
  const val = colors[colorKey]
  if (RGBA_FIELDS[colorKey]) {
    return (
      <TextField
        label={label}
        value={val}
        onChange={(v) => onChange({ ...colors, [colorKey]: v })}
      />
    )
  }
  return (
    <ColorField
      label={label}
      value={val}
      onChange={(v) => onChange({ ...colors, [colorKey]: v })}
    />
  )
}

function PaletteSection({
  title,
  colors,
  onChange,
}: {
  title: string
  colors: GlobalCssColors
  onChange: (next: GlobalCssColors) => void
}) {
  return (
    <fieldset className="form-palette">
      <legend>{title}</legend>
      <ColorRow label="Text" colorKey="text" colors={colors} onChange={onChange} />
      <ColorRow label="Text (heading)" colorKey="textH" colors={colors} onChange={onChange} />
      <ColorRow label="Background" colorKey="bg" colors={colors} onChange={onChange} />
      <ColorRow label="Border" colorKey="border" colors={colors} onChange={onChange} />
      <ColorRow label="Code background" colorKey="codeBg" colors={colors} onChange={onChange} />
      <ColorRow label="Accent" colorKey="accent" colors={colors} onChange={onChange} />
      <ColorRow label="Accent background" colorKey="accentBg" colors={colors} onChange={onChange} />
      <ColorRow label="Accent border" colorKey="accentBorder" colors={colors} onChange={onChange} />
    </fieldset>
  )
}

export default function GlobalCssForm({ value, onChange }: GlobalCssFormProps) {
  const settings = value as unknown as GlobalCssSettings

  function update(patch: Partial<GlobalCssSettings>) {
    onChange({ ...settings, ...patch } as unknown as JsonData)
  }

  return (
    <div className="form-section">
      <PaletteSection
        title="Light"
        colors={settings.light}
        onChange={(light) => update({ light })}
      />
      <PaletteSection title="Dark" colors={settings.dark} onChange={(dark) => update({ dark })} />
      <div className="form-row">
        <NumberField
          label="Root font size (px)"
          value={settings.rootFontSize}
          onChange={(v) => v !== null && update({ rootFontSize: v })}
          step={1}
          min={8}
          max={32}
        />
        <NumberField
          label="Narrow font size (px)"
          value={settings.rootFontSizeNarrow}
          onChange={(v) => v !== null && update({ rootFontSizeNarrow: v })}
          step={1}
          min={8}
          max={32}
        />
        <NumberField
          label="Narrow breakpoint (px)"
          value={settings.narrowBreakpoint}
          onChange={(v) => v !== null && update({ narrowBreakpoint: v })}
          step={16}
          min={320}
          max={1920}
        />
      </div>
    </div>
  )
}
