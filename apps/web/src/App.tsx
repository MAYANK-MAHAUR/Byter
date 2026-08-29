import {
  AlertTriangle,
  ArrowUpRight,
  Check,
  CircleDot,
  ClipboardCheck,
  FileCode2,
  GitPullRequestArrow,
  Lock,
  RadioTower,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Timer,
  X
} from "lucide-react";
import { useEffect, useMemo, useState, type ComponentType } from "react";
import type { RunEvent, RunStatus } from "@reprosmith/core";
import {
  readApprovalSubmission,
  submitApprovalAction,
  type ApprovalSubmission
} from "./approval-client";
import {
  fetchDashboardRun,
  happyPathStatuses,
  statusLabels,
  type ApprovalAction,
  type ApprovalActionId,
  type DashboardRun,
  type EvidenceItem
} from "./data";

const evidenceIcons: Record<EvidenceItem["kind"], ComponentType<{ size?: number }>> = {
  stdout: RadioTower,
  stack: AlertTriangle,
  patch: FileCode2,
  policy: ShieldAlert
};

const actionIcons: Record<ApprovalAction["impact"], ComponentType<{ size?: number }>> = {
  safe: GitPullRequestArrow,
  review: ClipboardCheck,
  blocked: X
};

function App() {
  const [run, setRun] = useState<DashboardRun | undefined>();
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | undefined>();
  const [pendingAction, setPendingAction] = useState<ApprovalActionId | undefined>();
  const [approval, setApproval] = useState<ApprovalSubmission | undefined>();
  const [approvalError, setApprovalError] = useState<string | undefined>();
  const displayedStatus: RunStatus | undefined = approval?.resultStatus ?? run?.status;
  const displayedEvents = useMemo(
    () => (run && displayedStatus ? appendApprovalEvent(run.events, displayedStatus, approval) : []),
    [approval, displayedStatus, run]
  );

  useEffect(() => {
    void loadRun();
  }, []);

  useEffect(() => {
    if (run?.source !== "webhook") {
      return undefined;
    }

    const refreshTimer = window.setInterval(() => {
      void loadRun();
    }, 5_000);

    return () => window.clearInterval(refreshTimer);
  }, [run?.source]);

  async function loadRun() {
    setIsRefreshing(true);
    setLoadError(undefined);

    try {
      const nextRun = await fetchDashboardRun();
      setRun(nextRun);
      setApproval(readApprovalSubmission(nextRun.id));
      setApprovalError(undefined);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Run API failed");
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  }

  async function handleApproval(actionId: ApprovalActionId) {
    if (!run) {
      return;
    }

    setPendingAction(actionId);
    setApprovalError(undefined);

    try {
      if (!run.candidatePatch) {
        setApprovalError("No patch approval is available for this run yet");
        return;
      }

      const result = await submitApprovalAction({
        runId: run.id,
        actionId,
        patchHash: run.candidatePatch.hash
      });
      setApproval(result);
    } catch (error) {
      setApprovalError(error instanceof Error ? error.message : "Approval save failed");
    } finally {
      setPendingAction(undefined);
    }
  }

  if (isLoading) {
    return (
      <main className="shell center-shell">
        <section className="load-state" aria-live="polite">
          <RefreshCw size={22} aria-hidden="true" />
          <h1>Loading ReproSmith run</h1>
          <p>Connecting to the ReproSmith API.</p>
        </section>
      </main>
    );
  }

  if (loadError || !run || !displayedStatus) {
    return (
      <main className="shell center-shell">
        <section className="load-state error" role="alert">
          <ShieldAlert size={24} aria-hidden="true" />
          <h1>ReproSmith API unavailable</h1>
          <p>{loadError ?? "No run payload was returned."}</p>
          <button type="button" className="refresh-button" disabled={isRefreshing} onClick={() => void loadRun()}>
            <RefreshCw size={16} aria-hidden="true" />
            {isRefreshing ? "Refreshing..." : "Refresh run"}
          </button>
        </section>
      </main>
    );
  }

  const progressLabel = progressLabelFor(displayedStatus);
  const latestQuarantine = run.quarantinedReports[0];
  const candidatePatch = run.candidatePatch;
  const pullRequest = approval?.pullRequest ?? run.pullRequest;

  return (
    <main className="shell">
      <header className="topbar" aria-label="Run summary">
        <div className="brand-lockup">
          <div className="brand-mark" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
          <div>
            <p className="eyebrow">ReproSmith console</p>
            <h1>{run.issueTitle}</h1>
          </div>
        </div>
        <a className="issue-link" href={run.issue.url}>
          Issue #{run.issue.issueNumber}
          <ArrowUpRight size={16} aria-hidden="true" />
        </a>
        <button type="button" className="refresh-button" disabled={isRefreshing} onClick={() => void loadRun()}>
          <RefreshCw size={16} aria-hidden="true" />
          {isRefreshing ? "Refreshing..." : "Refresh run"}
        </button>
      </header>

      <section className="proof-strip" aria-label="Run proof tape">
        <div>
          <span>{run.sourceLabel}</span>
          <span>base {run.issue.baseSha ?? "default HEAD"}</span>
          <span>{run.currentBranch}</span>
          {candidatePatch ? <span>{candidatePatch.hash}</span> : undefined}
          <span>generated {formatTime(run.generatedAt)}</span>
        </div>
        <strong>{progressLabel}</strong>
      </section>

      <div className="workspace">
        <aside className="timeline" aria-label="Run timeline">
          <div className="panel-head">
            <p className="eyebrow">Timeline</p>
            <span className="status-pill active">{statusLabels[displayedStatus]}</span>
          </div>
          <ol>
            {displayedEvents.map((event, index) => (
              <li key={event.id} className={index === displayedEvents.length - 1 ? "current" : ""}>
                <span className="timeline-dot">
                  {index === displayedEvents.length - 1 ? <CircleDot size={14} /> : <Check size={14} />}
                </span>
                <div>
                  <time dateTime={event.at}>{formatTime(event.at)}</time>
                  <h2>{statusLabels[event.status]}</h2>
                  <p>{event.message}</p>
                </div>
              </li>
            ))}
          </ol>
        </aside>

        <section className="evidence" aria-label="Evidence and approval">
          <div className="run-meta">
            <div>
              <p className="eyebrow">Repository</p>
              <h2>{run.repoLabel}</h2>
            </div>
            <dl>
              <div>
                <dt>Runtime</dt>
                <dd>{run.runtime}</dd>
              </div>
              <div>
                <dt>Model</dt>
                <dd>{run.model}</dd>
              </div>
              <div>
                <dt>Owner</dt>
                <dd>{run.assignee}</dd>
              </div>
            </dl>
          </div>

          <div className="evidence-grid">
            {run.evidence.map((item) => {
              const Icon = evidenceIcons[item.kind];
              return (
                <article key={item.id} className={`metric ${item.status}`}>
                  <div className="metric-icon">
                    <Icon size={18} aria-hidden="true" />
                  </div>
                  <div>
                    <p>{item.title}</p>
                    <strong>{item.value}</strong>
                    <span>{item.detail}</span>
                  </div>
                </article>
              );
            })}
          </div>

          {candidatePatch ? (
            <section className="approval-panel" aria-label="Approval controls">
              <div className="panel-head">
                <div>
                  <p className="eyebrow">Approval</p>
                  <h2>{candidatePatch.title}</h2>
                </div>
                <span className="hash-chip">
                  <Lock size={14} aria-hidden="true" />
                  {candidatePatch.hash}
                </span>
              </div>

              <ul className="file-list" aria-label="Patch files">
                {candidatePatch.files.map((file) => (
                  <li key={file}>
                    <FileCode2 size={15} aria-hidden="true" />
                    {file}
                  </li>
                ))}
              </ul>

              <div className={`approval-state ${approvalError ? "error" : approval ? "saved" : "idle"}`} role="status">
                {approvalError ?? approval?.message ?? (pullRequest ? `Draft PR #${pullRequest.number} created` : "Awaiting maintainer decision")}
              </div>

              {pullRequest ? (
                <a className="pr-link" href={pullRequest.url} target="_blank" rel="noreferrer">
                  <GitPullRequestArrow size={18} aria-hidden="true" />
                  Open draft PR #{pullRequest.number}
                  <ArrowUpRight size={16} aria-hidden="true" />
                </a>
              ) : displayedStatus === "awaiting-approval" ? (
                <div className="approval-actions">
                  {run.approvals.map((action) => {
                    const Icon = actionIcons[action.impact];
                    const isPending = pendingAction === action.id;
                    return (
                      <button
                        key={action.id}
                        type="button"
                        className={`action-button ${action.impact}`}
                        disabled={pendingAction !== undefined}
                        aria-busy={isPending}
                        onClick={() => void handleApproval(action.id)}
                      >
                        <Icon size={18} aria-hidden="true" />
                        <span>{isPending ? "Saving..." : action.label}</span>
                        <small>{action.description}</small>
                      </button>
                    );
                  })}
                </div>
              ) : undefined}
            </section>
          ) : (
            <section className="approval-panel waiting-panel" aria-label="Run orchestration">
              <div className="panel-head">
                <div>
                  <p className="eyebrow">Orchestration</p>
                  <h2>{statusLabels[displayedStatus]}</h2>
                </div>
                <span className="hash-chip">
                  <RadioTower size={14} aria-hidden="true" />
                  {run.source}
                </span>
              </div>
              <div className="approval-state idle" role="status">
                {run.events.at(-1)?.message ?? "Run is waiting for proof"}
              </div>
            </section>
          )}
        </section>

        <aside className="quarantine" aria-label="Security quarantine">
          <div className="panel-head">
            <div>
              <p className="eyebrow">Quarantine</p>
              <h2>Security review</h2>
            </div>
            <ShieldCheck size={20} aria-hidden="true" />
          </div>
          <div className="quarantine-state">
            <ShieldAlert size={24} aria-hidden="true" />
            <strong>{run.quarantinedReports.length} held</strong>
            <span>Latest: issue #{latestQuarantine?.issueNumber ?? "-"}</span>
          </div>
          {run.quarantinedReports.map((report) =>
            report.security.findings.map((finding) => (
              <article className="finding" key={`${report.id}:${finding.ruleId}`}>
                <div>
                  <span className={`severity ${finding.severity}`}>{finding.severity}</span>
                  <h3>{report.title}</h3>
                </div>
                <p>{finding.reason}</p>
                <code>{finding.matchedText}</code>
              </article>
            ))
          )}
          <div className="last-seen">
            <Timer size={16} aria-hidden="true" />
            Seen {formatTime(candidatePatch?.verifiedAt ?? run.updatedAt)}
          </div>
        </aside>
      </div>
    </main>
  );
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat("en", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(new Date(value));
}

export default App;

function appendApprovalEvent(
  events: RunEvent[],
  displayedStatus: RunStatus,
  approval: ApprovalSubmission | undefined
): RunEvent[] {
  if (!approval) {
    return events;
  }

  return [
    ...events,
    {
      id: approval.id,
      runId: approval.runId,
      at: approval.savedAt,
      status: displayedStatus,
      message: approval.message
    }
  ];
}

function progressLabelFor(status: RunStatus): string {
  const stageIndex = happyPathStatuses.indexOf(status);
  if (stageIndex === -1) {
    return "terminal branch";
  }

  return `stage ${stageIndex + 1}/${happyPathStatuses.length}`;
}
