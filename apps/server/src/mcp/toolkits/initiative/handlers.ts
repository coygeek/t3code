import * as Effect from "effect/Effect";

import * as InitiativeMcpService from "../../InitiativeMcpService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { InitiativeToolkit } from "./tools.ts";

export const layer = InitiativeToolkit.toLayer({
  t3_initiative_list: (input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* InitiativeMcpService.InitiativeMcpService;
      return yield* service.list(scope, input);
    }),
  t3_initiative_read: (input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* InitiativeMcpService.InitiativeMcpService;
      return yield* service.read(scope, input);
    }),
  t3_initiative_create: (input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* InitiativeMcpService.InitiativeMcpService;
      return yield* service.create(scope, input);
    }),
  t3_initiative_update: (input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* InitiativeMcpService.InitiativeMcpService;
      return yield* service.update(scope, input);
    }),
  t3_initiative_set_status: (input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* InitiativeMcpService.InitiativeMcpService;
      return yield* service.setStatus(scope, input);
    }),
});
