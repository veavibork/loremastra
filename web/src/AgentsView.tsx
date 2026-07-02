import { useEffect, useState } from "react";
import {
  createModelConfig,
  deleteModelConfig,
  fetchModelConfigs,
  reorderModelConfigs,
  updateModelConfig,
  type ModelConfig,
  type ModelConfigPatch,
} from "./api";
import "./AgentsView.css";

function numOrUndefined(value: string): number | undefined {
  if (value.trim() === "") return undefined;
  const n = Number(value);
  return Number.isNaN(n) ? undefined : n;
}

export default function AgentsView() {
  const [configs, setConfigs] = useState<ModelConfig[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void reload();
  }, []);

  async function reload() {
    setConfigs(await fetchModelConfigs());
  }

  async function patch(id: string, p: ModelConfigPatch) {
    try {
      const updated = await updateModelConfig(id, p);
      setConfigs((prev) => (prev ? prev.map((c) => (c.id === id ? updated : c)) : prev));
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleAdd() {
    try {
      const created = await createModelConfig();
      setConfigs((prev) => (prev ? [...prev, created] : [created]));
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleDelete(id: string) {
    try {
      await deleteModelConfig(id);
      setConfigs((prev) => (prev ? prev.filter((c) => c.id !== id) : prev));
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function move(index: number, direction: -1 | 1) {
    if (!configs) return;
    const target = index + direction;
    if (target < 0 || target >= configs.length) return;
    const next = [...configs];
    [next[index], next[target]] = [next[target], next[index]];
    setConfigs(next);
    try {
      const reordered = await reorderModelConfigs(next.map((c) => c.id));
      setConfigs(reordered);
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : String(err));
      await reload();
    }
  }

  if (!configs) return <div className="agents-view">Loading…</div>;

  return (
    <div className="agents-view">
      <h2>Agents</h2>
      <p className="agents-note">
        Each row is a model call profile. Check which agent role(s) it's eligible for; within a role,
        active rows are tried top to bottom — the first is primary, the rest are ranked fallbacks. Row
        order is shared across all three roles, so reordering affects every role's fallback chain at once.
      </p>
      {error && <div className="error-banner">{error}</div>}

      <div className="agents-table-wrap">
        <table className="agents-table">
          <thead>
            <tr>
              <th></th>
              <th>Model</th>
              <th>Temp</th>
              <th>Resp</th>
              <th>Ctx</th>
              <th>PresP</th>
              <th>FreqP</th>
              <th>RepP</th>
              <th>TopP</th>
              <th>TopK</th>
              <th>MinP</th>
              <th>A</th>
              <th>E</th>
              <th>W</th>
              <th>Active</th>
              <th>Stats</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {configs.map((cfg, index) => (
              <tr key={cfg.id} className={cfg.active ? "" : "row-inactive"}>
                <td className="reorder-cell">
                  <button type="button" onClick={() => move(index, -1)} disabled={index === 0} title="Move up">
                    ▲
                  </button>
                  <button
                    type="button"
                    onClick={() => move(index, 1)}
                    disabled={index === configs.length - 1}
                    title="Move down"
                  >
                    ▼
                  </button>
                </td>
                <td>
                  <input
                    className="model-input"
                    defaultValue={cfg.model}
                    placeholder="provider/Model-Name"
                    onBlur={(e) => e.target.value.trim() !== cfg.model && patch(cfg.id, { model: e.target.value.trim() })}
                  />
                </td>
                <td>
                  <input
                    type="number"
                    step="0.1"
                    className="num-input"
                    defaultValue={cfg.temperature}
                    onBlur={(e) => patch(cfg.id, { temperature: Number(e.target.value) })}
                  />
                </td>
                <td>
                  <input
                    type="number"
                    className="num-input"
                    defaultValue={cfg.responseLimit}
                    onBlur={(e) => patch(cfg.id, { responseLimit: Number(e.target.value) })}
                  />
                </td>
                <td>
                  <input
                    type="number"
                    className="num-input"
                    defaultValue={cfg.contextLimit}
                    onBlur={(e) => patch(cfg.id, { contextLimit: Number(e.target.value) })}
                  />
                </td>
                <td>
                  <input
                    type="number"
                    step="0.1"
                    className="num-input narrow"
                    defaultValue={cfg.presencePenalty ?? ""}
                    onBlur={(e) => patch(cfg.id, { presencePenalty: numOrUndefined(e.target.value) ?? null })}
                  />
                </td>
                <td>
                  <input
                    type="number"
                    step="0.1"
                    className="num-input narrow"
                    defaultValue={cfg.frequencyPenalty ?? ""}
                    onBlur={(e) => patch(cfg.id, { frequencyPenalty: numOrUndefined(e.target.value) ?? null })}
                  />
                </td>
                <td>
                  <input
                    type="number"
                    step="0.1"
                    className="num-input narrow"
                    defaultValue={cfg.repetitionPenalty ?? ""}
                    onBlur={(e) => patch(cfg.id, { repetitionPenalty: numOrUndefined(e.target.value) ?? null })}
                  />
                </td>
                <td>
                  <input
                    type="number"
                    step="0.05"
                    className="num-input narrow"
                    defaultValue={cfg.topP ?? ""}
                    onBlur={(e) => patch(cfg.id, { topP: numOrUndefined(e.target.value) ?? null })}
                  />
                </td>
                <td>
                  <input
                    type="number"
                    className="num-input narrow"
                    defaultValue={cfg.topK ?? ""}
                    onBlur={(e) => patch(cfg.id, { topK: numOrUndefined(e.target.value) ?? null })}
                  />
                </td>
                <td>
                  <input
                    type="number"
                    step="0.01"
                    className="num-input narrow"
                    defaultValue={cfg.minP ?? ""}
                    onBlur={(e) => patch(cfg.id, { minP: numOrUndefined(e.target.value) ?? null })}
                  />
                </td>
                <td className="checkbox-cell">
                  <input type="checkbox" checked={cfg.useAuthor} onChange={(e) => patch(cfg.id, { useAuthor: e.target.checked })} />
                </td>
                <td className="checkbox-cell">
                  <input type="checkbox" checked={cfg.useEditor} onChange={(e) => patch(cfg.id, { useEditor: e.target.checked })} />
                </td>
                <td className="checkbox-cell">
                  <input type="checkbox" checked={cfg.useWorker} onChange={(e) => patch(cfg.id, { useWorker: e.target.checked })} />
                </td>
                <td className="checkbox-cell">
                  <input type="checkbox" checked={cfg.active} onChange={(e) => patch(cfg.id, { active: e.target.checked })} />
                </td>
                <td className="stats-cell">
                  {cfg.successCount}✓ / {cfg.failCount}✗
                  <br />
                  {cfg.inputTokens}in / {cfg.outputTokens}out
                </td>
                <td>
                  <button type="button" className="danger" onClick={() => handleDelete(cfg.id)}>
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <button type="button" onClick={handleAdd}>
        + New model
      </button>
    </div>
  );
}
