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
  ShieldAlert,
  ShieldCheck,
  Timer,
  X
} from "lucide-react";
import type { ComponentType } from "react";
import { demoRun, statusLabels, type ApprovalAction, type EvidenceItem } from "./data";

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
  const run = demoRun;
  const completed = run.events.length;
  const total = Object.keys(statusLabels).length;

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
      </header>

      <section className="proof-strip" aria-label="Run proof tape">
        <div>
          <span>base {run.issue.baseSha}</span>
          <span>{run.currentBranch}</span>
          <span>{run.candidatePatch.hash}</span>
        </div>
        <strong>{completed}/{total}</strong>
      </section>

      <div className="workspace">
        <aside className="timeline" aria-label="Run timeline">
          <div className="panel-head">
            <p className="eyebrow">Timeline</p>
            <span className="status-pill active">{statusLabels[run.status]}</span>
          </div>
          <ol>
            {run.events.map((event, index) => (
              <li key={event.id} className={index === run.events.length - 1 ? "current" : ""}>
                <span className="timeline-dot">
                  {index === run.events.length - 1 ? <CircleDot size={14} /> : <Check size={14} />}
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

          <section className="approval-panel" aria-label="Approval controls">
            <div className="panel-head">
              <div>
                <p className="eyebrow">Approval</p>
                <h2>{run.candidatePatch.title}</h2>
              </div>
              <span className="hash-chip">
                <Lock size={14} aria-hidden="true" />
                {run.candidatePatch.hash}
              </span>
            </div>

            <ul className="file-list" aria-label="Patch files">
              {run.candidatePatch.files.map((file) => (
                <li key={file}>
                  <FileCode2 size={15} aria-hidden="true" />
                  {file}
                </li>
              ))}
            </ul>

            <div className="approval-actions">
              {run.approvals.map((action) => {
                const Icon = actionIcons[action.impact];
                return (
                  <button key={action.id} type="button" className={`action-button ${action.impact}`}>
                    <Icon size={18} aria-hidden="true" />
                    <span>{action.label}</span>
                    <small>{action.description}</small>
                  </button>
                );
              })}
            </div>
          </section>
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
            <strong>{run.security.findings.length} held</strong>
            <span>Safe execution: {run.security.safeToExecute ? "yes" : "no"}</span>
          </div>
          {run.security.findings.map((finding) => (
            <article className="finding" key={finding.ruleId}>
              <div>
                <span className={`severity ${finding.severity}`}>{finding.severity}</span>
                <h3>{finding.ruleId}</h3>
              </div>
              <p>{finding.reason}</p>
              <code>{finding.matchedText}</code>
            </article>
          ))}
          <div className="last-seen">
            <Timer size={16} aria-hidden="true" />
            Verified {formatTime(run.candidatePatch.verifiedAt)}
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
