// The contract between the pure core (config/board/handoff) and the pi
// integration layer (index/spawn/inject). Owned by the architect; neither
// worker changes this file without asking.

export type Role = "leader" | "planner" | "researcher" | "advisor" | "worker" | "qa" | "verifier";

/** Handoff destinations: any roster role, plus the leader, who is never in the roster. */
export type Destination = Role;

export type Verdict = "PASS" | "FAIL" | "APPROVED" | "CHANGES";

export type TaskStatus = "active" | "stopped" | "blocked" | "done";

export type SpecStatus = "pending" | "implementing" | "qa" | "done";

export type Thinking = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

// --- config (pi-blanche.json) ---

export interface AgentProfile {
	model: string;
	thinking: Thinking;
}

export interface Phase {
	name: string;
	owner: Role;
}

export interface WorkflowConfig {
	prefix: string;
	roles: Role[];
	phases: Phase[];
	specs: boolean;
	/** null = advisor escalation disabled */
	advisorAfter: number | null;
	maxRework: number;
	maxWorkers: number;
	/** optional per-workflow agent overrides */
	agents?: Partial<Record<Role, AgentProfile>>;
}

export interface BlancheConfig {
	agents: Record<string, AgentProfile>;
	context: { softLimit: number };
	workflows: Record<string, WorkflowConfig>;
}

/** Everything spawn needs, and everything resume must replay verbatim. */
export interface ResolvedCrew {
	workflow: string;
	prefix: string;
	roster: Role[];
	agents: Record<string, AgentProfile>;
	phases: Phase[];
	specs: boolean;
	advisorAfter: number | null;
	maxRework: number;
	maxWorkers: number;
	configRevision: string;
}

// --- board ---

export interface SpecState {
	status: SpecStatus;
	path: string;
	dependsOn: string[];
	parallelSafe?: boolean;
	writeScope?: string[];
	reworkRound: number;
	lastAdvisorConsultedRound: number | null;
}

export interface SessionState {
	sessionName: string;
	paneId?: string;
	contextEpoch: number;
	latestCheckpoint?: string;
}

export interface HandoffRecord {
	handoffId: string;
	from: Role;
	to: Destination;
	spec?: string;
	phase: string;
	verdict: Verdict | null;
	sentAt: number;
	ackedAt?: number;
}

export interface ConsultationRecord {
	id: string;
	role: Role;
	requestedBy: Role;
	spec?: string;
	reworkRound: number;
	summaryPath: string;
}

export interface Board {
	id: string;
	workflow: string;
	prefix: string;
	cwd: string;

	status: TaskStatus;
	phase: string;
	owner: Role;
	revision: number;

	task: { title: string; descriptionPath: string };
	plan?: { revision: number; status: "draft" | "approved"; contentPath: string };

	currentSpec?: string;
	specs: Record<string, SpecState>;
	consultations: ConsultationRecord[];

	leader: { sessionName: string; paneId?: string };
	resolved: ResolvedCrew;
	sessions: Partial<Record<Role, SessionState>>;

	/** task-level rework, used only when resolved.specs === false */
	reworkRound: number;
	lastAdvisorConsultedRound: number | null;

	history: HandoffRecord[];
}

// --- handoff (pure reducer) ---

export interface HandoffInput {
	board: Board;
	from: Role;
	to: Destination;
	phase: string;
	spec?: string;
	verdict?: Verdict | null;
	/** live session names from the intercom roster, for the liveness check */
	liveSessions: string[];
	now: number;
	handoffId: string;
}

export type HandoffDecision =
	| { ok: false; error: string }
	| {
			ok: true;
			board: Board;
			/** appended to the delivered message: advisor nudge, missing-checkpoint warning */
			notes: string[];
			target: string;
	  };

// --- checkpoint ---

export interface CheckpointInput {
	completed?: string[];
	decisions?: string[];
	failedApproaches?: { approach: string; result: string; whyItFailed: string }[];
	currentFailures?: string[];
	validation?: string[];
	filesChanged?: string[];
	remaining?: string[];
	nextAction?: string;
}
