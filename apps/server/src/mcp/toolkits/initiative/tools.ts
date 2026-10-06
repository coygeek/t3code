import {
  OrchestratorMcpFailure,
  OrchestratorMcpInitiativeCreateInput,
  OrchestratorMcpInitiativeListInput,
  OrchestratorMcpInitiativeListResult,
  OrchestratorMcpInitiativeReadInput,
  OrchestratorMcpInitiativeReadResult,
  OrchestratorMcpInitiativeResult,
  OrchestratorMcpInitiativeSetStatusInput,
  OrchestratorMcpInitiativeUpdateInput,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";

import * as InitiativeMcpService from "../../InitiativeMcpService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  InitiativeMcpService.InitiativeMcpService,
];

const ListTool = Tool.make("t3_initiative_list", {
  description:
    "List persistent initiatives and their saved objectives, briefs, plans, status, and linked workers. Omit projectId for this thread's repository project, or all projects for an external MCP client. Threads sharing a repository do not automatically belong to an initiative.",
  parameters: OrchestratorMcpInitiativeListInput,
  success: OrchestratorMcpInitiativeListResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "List initiatives")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const ReadTool = Tool.make("t3_initiative_read", {
  description:
    "Read a persistent initiative's objective, definition of done, brief, plan, decisions, links, blockers, requested user actions, results, status, and linked workers. Omit id to discover the initiative coordinated by this thread; initiative=null means this thread is not a coordinator. Read the saved brief when resuming and before preparing self-contained worker assignments with delegate_task. Incorporate worker results into the saved plan with t3_initiative_update.",
  parameters: OrchestratorMcpInitiativeReadInput,
  success: OrchestratorMcpInitiativeReadResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Read initiative")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const CreateTool = Tool.make("t3_initiative_create", {
  description:
    "Create a persistent initiative inside an existing repository project and attach an existing coordinator thread. Omit projectId and coordinatorThreadId to use this thread and its project. Save the objective, definition of done, brief, and plan. The coordinator delegates ordinary workers with delegate_task and updates saved progress; a worker finishing does not complete the initiative. Creation returns its durable id; retain that id before making further calls.",
  parameters: OrchestratorMcpInitiativeCreateInput,
  success: OrchestratorMcpInitiativeResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Create initiative")
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false);

const UpdateTool = Tool.make("t3_initiative_update", {
  description:
    "Save the current initiative objective, definition of done, brief, plan, decisions, links, blockers, userActions, or results. Each supplied text field replaces its saved value; omitted fields stay unchanged and an empty string clears a text field. Read the current initiative first to preserve useful context. Attach a replacement coordinator with coordinatorThreadId. Workers continue to use existing delegate_task tools. Use t3_initiative_set_status for pause, resume, completion, or reopening.",
  parameters: OrchestratorMcpInitiativeUpdateInput,
  success: OrchestratorMcpInitiativeResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Update initiative")
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true);

const SetStatusTool = Tool.make("t3_initiative_set_status", {
  description:
    "Set an initiative to paused, active, or completed. paused prevents new automatic initiative work while already-running workers remain visible and can be stopped separately with existing tools. active resumes a paused initiative or reopens a completed one. completed records completion of the initiative's definition of done; an individual worker finishing is insufficient. Every transition preserves the brief, decisions, and results.",
  parameters: OrchestratorMcpInitiativeSetStatusInput,
  success: OrchestratorMcpInitiativeResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Change initiative status")
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true);

export const InitiativeToolkit = Toolkit.make(
  ListTool,
  ReadTool,
  CreateTool,
  UpdateTool,
  SetStatusTool,
);
