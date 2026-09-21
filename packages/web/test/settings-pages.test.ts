import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { installDomStub, uninstallDomStub, type FakeElement } from "./dom-stub.js";
import { renderSettingsShell } from "../src/settings/settings-shell.js";
import { renderSecurityPage } from "../src/settings/security-page.js";
import { renderStoragePage } from "../src/settings/storage-page.js";
import { renderAboutPage, appVersion } from "../src/settings/about-page.js";
import { el } from "../src/dom.js";
import type { HealthSummary } from "../src/api.js";

describe("settings shell", () => {
  beforeEach(() => {
    installDomStub();
  });
  afterEach(() => {
    uninstallDomStub();
  });

  function q(root: HTMLElement, sel: string): HTMLElement {
    const found = root.querySelector(sel);
    assert.ok(found, `missing ${sel}`);
    return found as HTMLElement;
  }

  function health(): HealthSummary {
    return {
      status: "ok",
      security: { mode: "token" },
      persistence: { mode: "file", dataDir: "/tmp/wr-data" },
      diagnostics: { boot: { auth: { mode: "token", tokenSource: "WINDOWS_RUNNER_TOKEN env" } } },
    };
  }

  it("renders Security / Storage / About navigation with the active section marked", () => {
    let selected = "";
    const root = renderSettingsShell({
      section: "storage",
      onSelect: (s) => {
        selected = s;
      },
      content: el("div"),
    });
    assert.equal(root.getAttribute("data-testid"), "settings-page");
    for (const id of ["security", "storage", "about"]) {
      q(root, `[data-testid="settings-nav-${id}"]`);
    }
    const active = q(root, '[data-testid="settings-nav-storage"]');
    assert.equal(active.getAttribute("aria-current"), "page");
    assert.equal(q(root, '[data-testid="settings-nav-security"]').getAttribute("aria-current"), null);
    assert.ok(root.querySelector('[data-testid="settings-content"]'));
    (q(root, '[data-testid="settings-nav-about"]') as unknown as FakeElement).click();
    assert.equal(selected, "about");
  });

  it("security page is read-only information (no buttons, no inputs) and never renders a token", () => {
    const TOKEN = "super-secret-token-abc";
    const root = renderSecurityPage({ health: health(), server: { securityMode: "token", persistenceMode: "file" } });
    assert.equal(root.querySelectorAll("button, input, textarea, select").length, 0, "B2 adds no settings mutations");
    assert.match(q(root, '[data-testid="security-mode"]').textContent ?? "", /token/);
    const auth = q(root, '[data-testid="security-auth"]').textContent ?? "";
    assert.match(auth, /bearer token/);
    // tokenSource is a LABEL (where the token comes from), never the token.
    assert.match(auth, /WINDOWS_RUNNER_TOKEN env/);
    assert.equal(JSON.stringify((root as unknown as FakeElement).textContent).includes(TOKEN), false);
  });

  it("storage page shows persistence and the exposed data dir, and reset only targets the local catalog", () => {
    let resets = 0;
    const root = renderStoragePage({
      health: health(),
      server: { securityMode: "token", persistenceMode: "file" },
      desktopAvailable: false,
      onResetNavigationMetadata: () => {
        resets += 1;
      },
    });
    assert.match(q(root, '[data-testid="storage-persistence"]').textContent ?? "", /file/);
    assert.match(q(root, '[data-testid="storage-data-dir"]').textContent ?? "", /\/tmp\/wr-data/);
    (q(root, '[data-testid="reset-workspace-catalog"]') as unknown as FakeElement).click();
    assert.equal(resets, 1, "reset wires exactly the catalog-reset callback");
    assert.match(root.textContent ?? "", /provider profiles, and provider keys are NOT touched/i);
  });

  it("storage page hides the data dir when the server does not expose one (memory mode)", () => {
    const root = renderStoragePage({
      health: { status: "ok", persistence: { mode: "memory" } },
      server: { securityMode: "token", persistenceMode: "memory" },
      desktopAvailable: true,
      onResetNavigationMetadata: () => {},
    });
    assert.equal(root.querySelector('[data-testid="storage-data-dir"]'), null);
    assert.match(root.textContent ?? "", /desktop app's memory only|desktop app in its own application data/);
  });

  it("about page shows version, mode, and links — with no tokens in diagnostics", () => {
    const root = renderAboutPage({
      health: health(),
      server: { securityMode: "token", persistenceMode: "file" },
      desktopAvailable: true,
    });
    assert.match(q(root, '[data-testid="about-version"]').textContent ?? "", /\w/);
    assert.match(q(root, '[data-testid="about-mode"]').textContent ?? "", /Desktop/);
    assert.match(q(root, '[data-testid="about-persistence"]').textContent ?? "", /file/);
    q(root, '[data-testid="about-link-repository"]');
    q(root, '[data-testid="about-link-docs"]');
    const diag = q(root, '[data-testid="about-diagnostics"]').textContent ?? "";
    assert.equal(diag.includes("super-secret-token-abc"), false);
    assert.equal(appVersion().length > 0, true);
  });

  it("security page explains the trust, approval, and local-access models", () => {
    const root = renderSecurityPage({ health: health(), server: { securityMode: "token", persistenceMode: "file" } });
    const text = root.textContent ?? "";
    assert.match(text, /approving a single tool call never grants trust/, "project trust model is explained");
    assert.match(text, /explicit approve\/deny decision/, "approval model is explained");
    assert.match(q(root, '[data-testid="security-local-warning"]').textContent ?? "", /loopback/, "local/remote access information");
  });

  it("storage page describes browser and desktop catalog storage and token hygiene", () => {
    const browser = renderStoragePage({
      health: health(),
      server: { securityMode: "token", persistenceMode: "file" },
      desktopAvailable: false,
      onResetNavigationMetadata: () => {},
    });
    assert.match(browser.textContent ?? "", /kept in this browser's localStorage under one key/, "browser catalog behavior");
    assert.match(browser.textContent ?? "", /sessionStorage only/, "browser token hygiene");

    const desktop = renderStoragePage({
      health: health(),
      server: { securityMode: "token", persistenceMode: "file" },
      desktopAvailable: true,
      onResetNavigationMetadata: () => {},
    });
    assert.match(desktop.textContent ?? "", /desktop app in its own application data/, "desktop catalog behavior");
    assert.match(desktop.textContent ?? "", /desktop app's memory only/, "desktop token hygiene");
  });

  it("about page shows the runtime and the installation link", () => {
    const root = renderAboutPage({
      health: health(),
      server: { securityMode: "token", persistenceMode: "file" },
      desktopAvailable: false,
    });
    assert.ok((q(root, '[data-testid="about-runtime"]').textContent ?? "").length > 0, "runtime is shown");
    assert.match(q(root, '[data-testid="about-link-install"]').getAttribute("href") ?? "", /docs\/INSTALL\.md$/, "installation guide is linked");
  });

  it("no settings page offers credential inputs or renders secret-shaped values", () => {
    const health: HealthSummary = {
      status: "ok",
      security: { mode: "token" },
      persistence: { mode: "memory", dataDir: "/tmp/data" },
      diagnostics: { boot: { auth: { mode: "token", tokenSource: "environment" } } },
    };
    const pages = [
      renderSecurityPage({ health }),
      renderStoragePage({ health, desktopAvailable: false, onResetNavigationMetadata: () => {} }),
      renderAboutPage({ health, desktopAvailable: false }),
    ];
    for (const page of pages) {
      const text = JSON.stringify(page.textContent ?? "");
      assert.equal(page.querySelectorAll('input[type="password"]').length, 0, "settings never collect credentials");
      assert.match(text, /^(?!.*(sk-ant-|Bearer ))[\s\S]*$/, "no secret-shaped strings in rendered text");
    }
  });
});
