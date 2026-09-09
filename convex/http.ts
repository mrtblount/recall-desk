import { httpRouter } from "convex/server";
import { registerStaticRoutes } from "@convex-dev/static-hosting";
import { components } from "./_generated/api";
import { httpAction } from "./_generated/server";
import { auth } from "./auth";
import { agentmail } from "./email";

const http = httpRouter();

// Exact app routes (auth, webhooks) get registered here, ABOVE the static
// catch-all. Exact routes win over the catch-all, so adding them later never
// changes their URLs.

// Convex Auth: /.well-known/openid-configuration + /.well-known/jwks.json —
// these MUST live at the deployment root (the whole reason for app-owned
// root routing, decided Session 0).
auth.addHttpRoutes(http);

// AgentMail inbound webhook: svix-verified by the component, deduped by
// event_id; our routing callback runs via the component's callback pool.
http.route({
  path: "/agentmail/webhook",
  method: "POST",
  handler: httpAction(async (ctx, req) =>
    // @agentmail/convex 0.1.0 types against convex ^1.24 (runMutation had no
    // options arg); on 1.45 the ctx type differs. Known compat issue — the
    // cast is confined to this one call; runtime is unaffected.
    agentmail.handleWebhook(ctx as unknown as Parameters<typeof agentmail.handleWebhook>[0], req),
  ),
});

// Static site: serves the Vite build from the deployment root with SPA
// fallback (paths without an extension resolve to /index.html).
registerStaticRoutes(http, components.staticHosting);

export default http;
