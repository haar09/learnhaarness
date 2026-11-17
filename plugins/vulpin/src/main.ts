import type { PluginFrontendContext } from "learnharness-plugin-api";
import type { Status } from "./contract.ts";

export function activate(ctx: PluginFrontendContext): () => void {
  return ctx.registerSettings((container, signal) => {
    const panel = document.createElement("section");
    panel.className = "vulpin-settings";
    const heading = document.createElement("h2"); heading.textContent = "Vulpin connection";
    const statusLine = document.createElement("p"); statusLine.setAttribute("role", "status"); statusLine.textContent = "Checking connection…";
    const accountLine = document.createElement("p");
    const explanation = document.createElement("p"); explanation.textContent = "Connect your Vulpin account to search and read accessible learning sources during teaching and practice. Only requested pages are fetched. Existing conversation history keeps previously read material after disconnecting.";
    const form = document.createElement("form");
    const urlLabel = document.createElement("label"); urlLabel.textContent = "Vulpin server URL";
    const url = document.createElement("input"); url.type = "url"; url.required = true; url.value = "https://vulpinai.app"; url.autocomplete = "off"; urlLabel.append(url);
    const tokenLabel = document.createElement("label"); tokenLabel.textContent = "Connector token";
    const token = document.createElement("input"); token.type = "password"; token.required = true; token.autocomplete = "off"; token.spellcheck = false; tokenLabel.append(token);
    const hint = document.createElement("p"); hint.textContent = "Use a LearnHarness connector token supplied by your Vulpin administrator. The saved token stays on the LearnHarness server and is never returned here.";
    const controls = document.createElement("div"); controls.className = "vulpin-controls";
    const connect = document.createElement("button"); connect.type = "submit"; connect.textContent = "Connect";
    const check = document.createElement("button"); check.type = "button"; check.textContent = "Check connection";
    const disconnect = document.createElement("button"); disconnect.type = "button"; disconnect.textContent = "Disconnect"; disconnect.disabled = true;
    controls.append(connect, check, disconnect); form.append(urlLabel, tokenLabel, hint, controls); panel.append(heading, statusLine, accountLine, explanation, form); container.append(panel);
    let busy = false;
    let configured = false;
    let sequence = 0;
    let refreshPending = false;
    const display = (value: Status) => {
      if (signal.aborted) return;
      configured = value.configured;
      statusLine.textContent = value.connected ? "Connected" : value.configured ? `Connection unavailable${value.error ? `: ${value.error}` : ""}` : "Disconnected";
      accountLine.textContent = value.account ? `Account: ${value.account.email}` : "";
      if (value.baseUrl) url.value = value.baseUrl;
      disconnect.disabled = busy || !configured;
      connect.textContent = configured ? "Replace connection" : "Connect";
    };
    const run = async (operation: string, input?: unknown) => {
      if (busy || signal.aborted) return;
      busy = true;
      const request = ++sequence;
      connect.disabled = check.disabled = disconnect.disabled = true;
      try {
        const response = await ctx.call(operation, input);
        if (!signal.aborted && sequence === request) display(response as Status);
      } catch (error) {
        if (!signal.aborted && sequence === request) statusLine.textContent = error instanceof Error ? error.message : "Vulpin connection failed";
      } finally {
        if (operation === "connect") token.value = "";
        busy = false;
        if (!signal.aborted) { connect.disabled = check.disabled = false; disconnect.disabled = !configured; if (refreshPending) { refreshPending = false; void run("status"); } }
      }
    };
    form.addEventListener("submit", event => { event.preventDefault(); const input = { baseUrl: url.value.trim(), token: token.value.trim() }; token.value = ""; void run("connect", input); }, { signal });
    check.addEventListener("click", () => { void run("status"); }, { signal });
    disconnect.addEventListener("click", () => { void run("disconnect"); }, { signal });
    const unsubscribe = ctx.onNotification(event => { if (event.topic === "connection-changed") { if (busy) refreshPending = true; else void run("status"); } });
    const resync = ctx.onResync(() => { if (busy) refreshPending = true; else void run("status"); });
    void run("status");
    return () => { sequence++; token.value = ""; unsubscribe(); resync(); panel.remove(); };
  });
}
