import {
  Activity,
  AlertTriangle,
  ArrowUpRight,
  Bot,
  Check,
  ChevronDown,
  CircleDot,
  ClipboardCheck,
  Cloud,
  Copy,
  FileCode2,
  GitBranch,
  GitCommitHorizontal,
  GitPullRequestArrow,
  Layers3,
  Link2,
  Lock,
  MessageSquareText,
  RadioTower,
  RefreshCw,
  Server,
  ShieldAlert,
  ShieldCheck,
  Terminal,
  Timer,
  User,
  X
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import type { RunEvent, RunStatus } from "@reprosmith/core";
import { readApprovalSubmission, submitApprovalAction, type ApprovalSubmission } from "./approval-client";
import {
  fetchDashboardRun,
  happyPathStatuses,
  statusLabels,
  type ApprovalAction,
  type ApprovalActionId,
  type DashboardRun,
  type HarnessState,
  type HarnessTraceEvent
} from "./data";

type ViewId = "overview" | "trace" | "reproduction" | "patch" | "security";

const views: Array<{ id: ViewId; label: string; icon: typeof Activity }> = [
  { id: "overview", label: "Overview", icon: Activity },
  { id: "trace", label: "Harness trace", icon: Terminal },
  { id: "reproduction", label: "Reproduction", icon: RadioTower },
  { id: "patch", label: "Patch", icon: FileCode2 },
  { id: "security", label: "Security", icon: ShieldCheck }
];

function App() {
  const [run, setRun] = useState<DashboardRun | undefined>();
  const [activeView, setActiveView] = useState<ViewId>("overview");
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | undefined>();
  const [pendingAction, setPendingAction] = useState<ApprovalActionId | undefined>();
  const [approval, setApproval] = useState<ApprovalSubmission | undefined>();
  const [approvalError, setApprovalError] = useState<string | undefined>();
  const displayedStatus: RunStatus | undefined = approval?.resultStatus ?? run?.status;

  useEffect(() => {
    void loadRun();
  }, []);

  useEffect(() => {
    if (run?.source !== "webhook") return undefined;
    const refreshTimer = window.setInterval(() => void loadRun(), 5_000);
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
    if (!run?.candidatePatch) return;
    setPendingAction(actionId);
    setApprovalError(undefined);
    try {
      const result = await submitApprovalAction({ runId: run.id, actionId, patchHash: run.candidatePatch.hash });
      setApproval(result);
      await loadRun();
    } catch (error) {
      setApprovalError(error instanceof Error ? error.message : "Approval save failed");
    } finally {
      setPendingAction(undefined);
    }
  }

  if (isLoading) {
    return <StatusScreen icon={<RefreshCw size={22} />} title="Loading ReproSmith run" detail="Connecting to the run record." />;
  }

  if (loadError || !run || !displayedStatus) {
    return (
      <StatusScreen
        icon={<ShieldAlert size={24} />}
        title="Run record unavailable"
        detail={loadError ?? "No persisted run payload was returned."}
        error
        action={
          <button type="button" className="button button-primary" disabled={isRefreshing} onClick={() => void loadRun()}>
            <RefreshCw size={16} aria-hidden="true" />
            {isRefreshing ? "Refreshing" : "Refresh run"}
          </button>
        }
      />
    );
  }

  const currentStatus = displayedStatus;
  const pullRequest = approval?.pullRequest ?? run.pullRequest;

  return (
    <main className="shell">
      <header className="topbar" aria-label="Run summary">
        <div className="brand-lockup">
          <div className="brand-mark" aria-hidden="true"><span /><span /><span /></div>
          <div>
            <p className="eyebrow">ReproSmith / live run console</p>
            <h1>{run.issueTitle}</h1>
            <p className="header-subtitle">{run.repoLabel} <span>/</span> issue #{run.issue.issueNumber}</p>
          </div>
        </div>
        <div className="header-actions">
          <span className={`status-pill status-${statusTone(currentStatus)}`}><CircleDot size={12} />{statusLabels[currentStatus]}</span>
          <a className="icon-button" href={run.issue.url} target="_blank" rel="noreferrer" aria-label="Open GitHub issue" title="Open GitHub issue">
            <ArrowUpRight size={17} />
          </a>
          <button type="button" className="icon-button" disabled={isRefreshing} onClick={() => void loadRun()} aria-label="Refresh run" title="Refresh run">
            <RefreshCw size={17} className={isRefreshing ? "spin" : undefined} />
          </button>
        </div>
      </header>

      <section className="run-ribbon" aria-label="Run identity">
        <div className="ribbon-copy"><span className="live-indicator" />{run.sourceLabel}<span className="ribbon-divider" />{run.currentBranch}</div>
        <div className="ribbon-links">
          {run.harness.dashboardUrl ? <a href={run.harness.dashboardUrl}><Link2 size={14} />Permanent run URL</a> : undefined}
          {run.harness.statusCommentUrl ? <a href={run.harness.statusCommentUrl} target="_blank" rel="noreferrer"><MessageSquareText size={14} />GitHub updates ({run.harness.commentHistory.length})</a> : undefined}
          <strong>{progressLabelFor(currentStatus)}</strong>
        </div>
      </section>

      <HarnessPanel harness={run.harness} run={run} />

      <nav className="view-tabs" aria-label="Run evidence views">
        {views.map(({ id, label, icon: Icon }) => (
          <button key={id} type="button" className={activeView === id ? "active" : undefined} onClick={() => setActiveView(id)} aria-current={activeView === id ? "page" : undefined}>
            <Icon size={16} />{label}
            {id === "trace" ? <span className="tab-count">{run.harness.trace.length}</span> : undefined}
          </button>
        ))}
      </nav>

      {activeView === "overview" ? (
        <OverviewView run={run} currentStatus={currentStatus} pullRequest={pullRequest} approval={approval} approvalError={approvalError} pendingAction={pendingAction} onApproval={handleApproval} />
      ) : activeView === "trace" ? (
        <TraceView harness={run.harness} />
      ) : activeView === "reproduction" ? (
        <ReproductionView run={run} />
      ) : activeView === "patch" ? (
        <PatchView run={run} pullRequest={pullRequest} />
      ) : (
        <SecurityView run={run} />
      )}
    </main>
  );
}

function StatusScreen({ icon, title, detail, error, action }: { icon: ReactNode; title: string; detail: string; error?: boolean; action?: ReactNode }) {
  return <main className="shell center-shell"><section className={`load-state ${error ? "error" : ""}`} role={error ? "alert" : undefined}>{icon}<h1>{title}</h1><p>{detail}</p>{action}</section></main>;
}

function HarnessPanel({ harness, run }: { harness: HarnessState; run: DashboardRun }) {
  const statusLabel = harness.status === "fixture" ? "Fixture trace" : harness.status === "paused" ? "Paused for approval" : harness.status === "not-configured" ? "Not connected" : harness.status;
  return (
    <section className={`harness-panel harness-${harness.status}`} aria-label="TrueForge harness">
      <div className="harness-heading">
        <div className="harness-name"><div className="harness-orbit"><Bot size={20} /></div><div><p className="eyebrow">TrueForge</p><h2>Live harness</h2></div></div>
        <div className="harness-state"><span className="state-dot" />{statusLabel}<span className="state-source">{run.source === "demo" ? "demo data" : "persisted run"}</span></div>
      </div>
      <div className="harness-grid">
        <div className="session-summary">
          <p className="eyebrow">Current task</p>
          <h3>{harness.currentTask}</h3>
          <div className="session-identifiers">
            <span><Server size={14} />{harness.provider}</span>
            <span><Bot size={14} />{harness.model}</span>
            <span><Link2 size={14} />{harness.sessionId ? `session ${shortId(harness.sessionId)}` : "session pending"}</span>
            {harness.turnId ? <span><Activity size={14} />turn {shortId(harness.turnId)}</span> : undefined}
          </div>
        </div>
        <div className="harness-metrics" aria-label="Harness evidence counts">
          <Metric label="MCP calls" value={harness.mcpCalls} icon={<Layers3 size={16} />} />
          <Metric label="Sandbox" value={harness.sandboxExecutions} icon={<Cloud size={16} />} />
          <Metric label="Subagents" value={harness.subagents} icon={<User size={16} />} />
          <Metric label="Trace events" value={harness.trace.length} icon={<Activity size={16} />} />
        </div>
      </div>
      <AgentRail harness={harness} run={run} />
      <GitHubActivity harness={harness} />
    </section>
  );
}

function Metric({ label, value, icon }: { label: string; value: number; icon: ReactNode }) {
  return <div className="harness-metric"><span>{icon}</span><strong>{value}</strong><small>{label}</small></div>;
}

function AgentRail({ harness, run }: { harness: HarnessState; run: DashboardRun }) {
  const roles = [
    { label: "Orchestrator", state: harness.status === "failed" ? "failed" : harness.status === "completed" || harness.status === "paused" || harness.status === "fixture" ? "complete" : "active" },
    { label: "Triage agent", state: roleState(harness, "read_issue", run.status) },
    { label: "Repository agent", state: roleState(harness, "read_file", run.status) },
    { label: "Reproduction agent", state: harness.sandboxExecutions > 0 ? "complete" : run.status === "reproducing" ? "active" : "pending" },
    { label: "Fix agent", state: run.candidatePatch ? "complete" : ["fixing", "validating"].includes(run.status) ? "active" : "pending" }
  ];
  return <div className="agent-rail"><div className="rail-label"><WorkflowIcon />Agent activity</div><div className="agent-list">{roles.map((role) => <div className="agent-item" key={role.label}><span className={`agent-mark ${role.state}`} /> <span>{role.label}</span><small>{role.state === "complete" ? "observed" : role.state === "active" ? "working" : role.state === "failed" ? "failed" : "not observed"}</small></div>)}</div></div>;
}

function GitHubActivity({ harness }: { harness: HarnessState }) {
  if (harness.commentHistory.length === 0 && !harness.verifiedLabel && !harness.approvalLabel) return null;
  const latestComment = harness.commentHistory.at(-1);
  return <div className="github-activity"><div className="rail-label"><MessageSquareText size={15} />GitHub activity</div><div className="github-activity-details"><strong>{harness.commentHistory.length} progress comment{harness.commentHistory.length === 1 ? "" : "s"}</strong>{harness.verifiedLabel?.appliedAt ? <span className="label-chip label-valid">valid</span> : harness.verifiedLabel?.error ? <span className="label-chip label-error">valid label failed</span> : undefined}{harness.approvalLabel?.appliedAt ? <span className="label-chip label-waiting">waiting approval</span> : harness.approvalLabel?.error ? <span className="label-chip label-error">approval label failed</span> : undefined}{latestComment ? <a href={latestComment.url} target="_blank" rel="noreferrer">Open latest update <ArrowUpRight size={13} /></a> : undefined}</div></div>;
}

function WorkflowIcon() { return <Layers3 size={15} />; }

function roleState(harness: HarnessState, toolName: string, status: RunStatus): string {
  if (harness.trace.some((event) => event.toolName === toolName)) return "complete";
  if (status === "triaging" && toolName === "read_issue") return "active";
  if (status === "environment-building" && toolName === "read_file") return "active";
  return "pending";
}

function OverviewView({ run, currentStatus, pullRequest, approval, approvalError, pendingAction, onApproval }: { run: DashboardRun; currentStatus: RunStatus; pullRequest?: { number: number; url: string }; approval?: ApprovalSubmission; approvalError?: string; pendingAction?: ApprovalActionId; onApproval: (actionId: ApprovalActionId) => Promise<void> }) {
  const displayedEvents = appendApprovalEvent(run.events, currentStatus, approval);
  return <div className="overview-grid"><Timeline events={displayedEvents} status={currentStatus} /><section className="panel why-panel"><PanelTitle eyebrow="Verified finding" title="Why this run matters" icon={<ClipboardCheck size={17} />} /><div className="finding-callout"><ShieldCheck size={20} /><div><strong>{compactSummary(run.summary) ?? run.proof?.before ?? "Proof summary is still being collected"}</strong><p>{run.summary ? run.proof?.before ?? "The failure was reproduced before the candidate change." : run.proof?.after ?? "The harness will place before and after evidence here."}</p></div></div><div className="proof-points"><ProofPoint icon={<Terminal size={15} />} label="Regression check" value={run.proof?.regressions ?? "Not returned yet"} /><ProofPoint icon={<RadioTower size={15} />} label="Attempts" value={run.proof?.attempts ?? "Not returned yet"} /></div></section><ApprovalPanel run={run} currentStatus={currentStatus} pullRequest={pullRequest} approval={approval} approvalError={approvalError} pendingAction={pendingAction} onApproval={onApproval} /></div>;
}

function Timeline({ events, status }: { events: RunEvent[]; status: RunStatus }) {
  return <section className="panel timeline-panel"><PanelTitle eyebrow="Run timeline" title="Investigation stages" icon={<Activity size={17} />} /><ol className="timeline-list">{events.map((event, index) => <li key={event.id} className={index === events.length - 1 ? "current" : ""}><span className="timeline-dot">{index === events.length - 1 ? <CircleDot size={13} /> : <Check size={13} />}</span><div><time dateTime={event.at}>{formatTime(event.at)}</time><h3>{statusLabels[event.status]}</h3><p>{event.message}</p></div></li>)}</ol><div className="timeline-current"><span className={`status-dot status-${statusTone(status)}`} />Current: {statusLabels[status]}</div></section>;
}

function ApprovalPanel({ run, currentStatus, pullRequest, approval, approvalError, pendingAction, onApproval }: { run: DashboardRun; currentStatus: RunStatus; pullRequest?: { number: number; url: string }; approval?: ApprovalSubmission; approvalError?: string; pendingAction?: ApprovalActionId; onApproval: (actionId: ApprovalActionId) => Promise<void> }) {
  const patch = run.candidatePatch;
  return <section className="panel approval-panel"><PanelTitle eyebrow="Mutation gate" title={pullRequest ? "Draft pull request" : patch ? patch.title : "Awaiting proof"} icon={<Lock size={17} />} />{patch ? <><div className="approval-meta"><span><Lock size={13} />hash <code>{patch.hash}</code></span><span><FileCode2 size={13} />{patch.files.length} files</span></div><ul className="file-list">{patch.files.map((file) => <li key={file}><FileCode2 size={14} />{file}</li>)}</ul>{currentStatus === "awaiting-approval" && !pullRequest ? <><div className="preapproval-state"><ShieldCheck size={17} /><div><strong>Paused before GitHub mutation</strong><span>No branch or pull request has been created.</span></div></div><GitHubApprovalGuide /></> : undefined}<div className={`approval-state ${approvalError ? "error" : approval ? "saved" : ""}`} role="status">{approvalError ?? approval?.message ?? (pullRequest ? `Draft PR #${pullRequest.number} recorded` : "Maintainer decision required")}</div>{pullRequest ? <a className="button button-success" href={pullRequest.url} target="_blank" rel="noreferrer"><GitPullRequestArrow size={17} />Open draft PR #{pullRequest.number}<ArrowUpRight size={15} /></a> : currentStatus === "awaiting-approval" ? <div className="approval-actions"><p className="control-label">Website controls</p>{run.approvals.map((action) => <ApprovalActionButton key={action.id} action={action} pending={pendingAction === action.id} disabled={pendingAction !== undefined} onClick={onApproval} />)}</div> : undefined}</> : <div className="empty-state"><RadioTower size={20} /><p>{run.events.at(-1)?.message ?? "Run is waiting for a candidate proof."}</p></div>}</section>;
}

function GitHubApprovalGuide() {
  const [copied, setCopied] = useState(false);
  const command = "approve";

  async function copyCommand() {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  }

  return <div className="github-approval-guide"><strong>Approve from GitHub</strong><p>Review the proposed file contents in the Patch tab, then post this exact word as a new issue comment.</p><div className="github-approval-command"><code>{command}</code><button type="button" className="copy-command" onClick={() => void copyCommand()} aria-label="Copy GitHub approval command" title={copied ? "Copied" : "Copy command"}>{copied ? <Check size={16} /> : <Copy size={16} />}</button></div><small>Only repository maintainers can approve. The newest awaiting patch for this issue is selected, then its stored hash is verified before a draft PR is created.</small></div>;
}

function ApprovalActionButton({ action, pending, disabled, onClick }: { action: ApprovalAction; pending: boolean; disabled: boolean; onClick: (id: ApprovalActionId) => Promise<void> }) {
  const Icon = action.impact === "safe" ? GitPullRequestArrow : action.impact === "review" ? ClipboardCheck : X;
  return <button type="button" className={`action-button ${action.impact}`} disabled={disabled} onClick={() => void onClick(action.id)} aria-busy={pending}><Icon size={17} /><span>{pending ? "Saving" : action.label}</span><small>{action.description}</small></button>;
}

function TraceView({ harness }: { harness: HarnessState }) {
  return <section className="panel trace-panel"><PanelTitle eyebrow="Executable evidence" title="Harness trace" icon={<Terminal size={17} />} /><div className="trace-intro"><span>{harness.trace.length ? `${harness.trace.length} persisted events` : "No rich events persisted"}</span><span>{harness.status === "fixture" ? "fixture trace" : harness.status === "paused" ? "checkpoint active" : "updates every 5 seconds"}</span></div>{harness.trace.length ? <ol className="trace-list">{harness.trace.map((event) => <TraceRow key={event.id} event={event} />)}</ol> : <div className="empty-state trace-empty"><Terminal size={22} /><div><strong>Trace details are not available for this run</strong><p>This historical record predates rich event persistence. New runs show tool calls, sandbox commands, and bounded output here.</p></div></div>}</section>;
}

function TraceRow({ event }: { event: HarnessTraceEvent }) {
  const hasOutput = Boolean(event.command || event.stdout || event.stderr);
  return <li className={`trace-row trace-${event.category}`}><div className="trace-icon">{traceIcon(event.category)}</div><div className="trace-main"><div className="trace-topline"><span className="trace-category">{event.category}</span><time dateTime={event.at}>{formatTime(event.at)}</time>{event.sequenceNumber !== undefined ? <span className="trace-sequence">#{event.sequenceNumber}</span> : undefined}</div><strong>{event.summary}</strong><div className="trace-details">{event.toolName ? <span>{event.toolName}</span> : undefined}{event.target ? <span>{event.target}</span> : undefined}{event.sandboxId ? <span>{shortId(event.sandboxId)}</span> : undefined}{event.exitCode !== undefined ? <span className={event.exitCode === 0 ? "text-success" : "text-danger"}>exit {event.exitCode ?? "?"}</span> : undefined}</div>{hasOutput ? <details className="trace-output"><summary><ChevronDown size={14} />Inspect bounded output</summary>{event.command ? <code>$ {event.command}</code> : undefined}{event.stdout ? <pre>{event.stdout}</pre> : undefined}{event.stderr ? <pre className="stderr">{event.stderr}</pre> : undefined}</details> : undefined}</div></li>;
}

function ReproductionView({ run }: { run: DashboardRun }) {
  return <section className="panel evidence-view"><PanelTitle eyebrow="Proof" title="Reproduction" icon={<RadioTower size={17} />} /><div className="proof-grid"><ProofBlock label="Before patch" value={run.proof?.before ?? "No before-run evidence returned."} tone="failure" /><ProofBlock label="After patch" value={run.proof?.after ?? "No after-run evidence returned."} tone="success" /><ProofBlock label="Regression suite" value={run.proof?.regressions ?? "No regression evidence returned."} tone="neutral" /></div><div className="evidence-note"><AlertTriangle size={16} /><span>Only bounded command output is shown. Private model reasoning is intentionally omitted.</span></div></section>;
}

function PatchView({ run, pullRequest }: { run: DashboardRun; pullRequest?: { number: number; url: string } }) {
  const patch = run.candidatePatch;
  return <section className="panel evidence-view"><PanelTitle eyebrow="Candidate change" title={patch?.title ?? "No candidate patch"} icon={<FileCode2 size={17} />} />{patch ? <><div className="patch-meta"><span><GitBranch size={15} />{run.currentBranch}</span><span><Lock size={15} />{patch.hash}</span><span><Timer size={15} />verified {formatTime(patch.verifiedAt)}</span></div>{patch.body ? <div className="remedy-box"><p className="eyebrow">Proposed remedy</p><p>{patch.body}</p></div> : undefined}<div className="patch-file-heading"><p className="eyebrow">Proposed file contents</p><span>{patch.fileContents?.length ?? patch.files.length} file{patch.files.length === 1 ? "" : "s"}</span></div><ul className="file-list patch-files">{patch.files.map((file) => <li key={file}><FileCode2 size={14} />{file}</li>)}</ul>{patch.fileContents?.length ? <div className="patch-file-list">{patch.fileContents.map((file) => <details className="patch-file" key={file.path}><summary><FileCode2 size={14} />{file.path}</summary><pre className="patch-file-content">{file.content}</pre></details>)}</div> : undefined}{pullRequest ? <a className="button button-success" href={pullRequest.url} target="_blank" rel="noreferrer"><GitPullRequestArrow size={17} />Open draft PR #{pullRequest.number}<ArrowUpRight size={15} /></a> : <div className="preapproval-state"><GitCommitHorizontal size={17} /><div><strong>Write is still gated</strong><span>The candidate patch remains a proposal until approval.</span></div></div>}</> : <div className="empty-state"><FileCode2 size={22} /><p>No candidate patch has been returned by the harness.</p></div>}</section>;
}

function SecurityView({ run }: { run: DashboardRun }) {
  const safe = run.security.safeToExecute;
  return <section className="panel evidence-view"><PanelTitle eyebrow="Input policy" title="Security review" icon={safe ? <ShieldCheck size={17} /> : <ShieldAlert size={17} />} /><div className={`security-banner ${safe ? "safe" : "blocked"}`}>{safe ? <ShieldCheck size={22} /> : <ShieldAlert size={22} />}<div><strong>{safe ? "Issue cleared for execution" : "Issue held before execution"}</strong><span>{run.security.findings.length} finding{run.security.findings.length === 1 ? "" : "s"} detected</span></div></div>{run.security.findings.length ? <div className="security-findings">{run.security.findings.map((finding) => <article className="security-finding" key={finding.ruleId}><span className={`severity ${finding.severity}`}>{finding.severity}</span><div><h3>{finding.ruleId}</h3><p>{finding.reason}</p><code>{finding.matchedText}</code></div></article>)}</div> : <div className="empty-state"><ShieldCheck size={20} /><p>No prompt-injection or credential-exfiltration findings were recorded.</p></div>}</section>;
}

function PanelTitle({ eyebrow, title, icon }: { eyebrow: string; title: string; icon: ReactNode }) { return <div className="panel-title"><div><p className="eyebrow">{eyebrow}</p><h2>{title}</h2></div><span className="panel-icon">{icon}</span></div>; }
function ProofPoint({ icon, label, value }: { icon: ReactNode; label: string; value: string }) { return <div className="proof-point"><span>{icon}</span><div><small>{label}</small><strong>{value}</strong></div></div>; }
function ProofBlock({ label, value, tone }: { label: string; value: string; tone: string }) { return <article className={`proof-block ${tone}`}><p className="eyebrow">{label}</p><strong>{value}</strong></article>; }

function traceIcon(category: HarnessTraceEvent["category"]) { if (category === "mcp") return <Layers3 size={16} />; if (category === "sandbox") return <Cloud size={16} />; if (category === "subagent") return <User size={16} />; if (category === "github") return <GitPullRequestArrow size={16} />; if (category === "approval") return <Lock size={16} />; if (category === "session") return <Activity size={16} />; return <Bot size={16} />; }
function statusTone(status: RunStatus): string { if (["failed", "rejected", "fix-failed", "environment-failed"].includes(status)) return "danger"; if (["awaiting-approval", "needs-info", "not-reproduced", "flaky"].includes(status)) return "warning"; if (["pr-created", "approved", "verified", "patch-ready"].includes(status)) return "success"; return "active"; }
function formatTime(value: string): string { return new Intl.DateTimeFormat("en", { hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value)); }
function shortId(value: string): string { return value.length > 22 ? `${value.slice(0, 10)}...${value.slice(-8)}` : value; }
function compactSummary(value?: string): string | undefined { const compact = value?.replace(/\s+/g, " ").trim(); if (!compact) return undefined; const sentence = compact.match(/^.{1,360}?(?:[.!?](?:\s|$)|$)/)?.[0] ?? compact; return sentence.length <= 380 ? sentence : `${sentence.slice(0, 377).trimEnd()}...`; }
function progressLabelFor(status: RunStatus): string { const index = happyPathStatuses.indexOf(status); return index === -1 ? "terminal state" : `stage ${index + 1}/${happyPathStatuses.length}`; }
function appendApprovalEvent(events: RunEvent[], status: RunStatus, approval?: ApprovalSubmission): RunEvent[] { return approval ? [...events, { id: approval.id, runId: approval.runId, at: approval.savedAt, status, message: approval.message }] : events; }

export default App;
