import { useCallback, useEffect, useState } from "react";
import {
  enqueueStoryToDate,
  fetchStoryToDate,
  requeueStoryToDateSegment,
  type StoryToDatePage,
  type StoryToDateSegment,
} from "./api";
import type { PanelProps } from "./panel-types";
import "./ArchivesView.css";

export default function ArchivesView({ story }: PanelProps) {
  const [segments, setSegments] = useState<StoryToDateSegment[]>([]);
  const [coverage, setCoverage] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!story?.id) return;
    try {
      const page: StoryToDatePage = await fetchStoryToDate(story.id);
      setSegments(page.segments);
      setCoverage(page.mergedCoverageThroughPost);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [story?.id]);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function runAction(key: string, fn: () => Promise<unknown>) {
    setBusy(key);
    setError(null);
    try {
      await fn();
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  if (!story) return <div className="archives-view">No active story.</div>;

  return (
    <div className="archives-view">
      <div className="archives-header">
        <h2>Story to date</h2>
        <button type="button" disabled={!!busy} onClick={() => void runAction("enqueue", () => enqueueStoryToDate(story.id))}>
          Queue job
        </button>
      </div>

      {error && <p className="archives-error">{error}</p>}
      {coverage != null && (
        <p className="archives-count">Coverage through IC post {coverage}</p>
      )}
      {segments.length === 0 && <p className="archives-empty">No [STORY TO DATE] segments yet.</p>}

      <div className="archives-list">
        {segments.map((seg) => (
          <article key={seg.id} className="archive-card">
            <header>
              <strong>
                [{seg.kind}] seq {seg.seq}
              </strong>
              {seg.broken && <span> broken</span>}
              {seg.jobActive && <span> job active</span>}
            </header>
            {seg.coverageThroughIcPost != null && (
              <p>Coverage: post {seg.coverageThroughIcPost}</p>
            )}
            {seg.content ? (
              <p className="archive-summary">{seg.content.slice(0, 400)}{seg.content.length > 400 ? "…" : ""}</p>
            ) : (
              <p className="archive-summary">(pending)</p>
            )}
            {!seg.content?.trim() && !seg.jobActive && (
              <button
                type="button"
                disabled={!!busy}
                onClick={() => void runAction(seg.id, () => requeueStoryToDateSegment(story.id, seg.id))}
              >
                Requeue
              </button>
            )}
          </article>
        ))}
      </div>
    </div>
  );
}
