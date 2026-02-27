// SYKE Dashboard — Advanced v2.1

let Graph = null;
let graphData = null;
let selectedFile = null;
let autoRotate = false;
let highlightNodes = new Set();
let highlightLinks = new Set();
let selectedNodeId = null;
let hiddenLayers = new Set();
let hiddenNodes = new Set();
let pathMode = false;
let pathFrom = null;
let pathTo = null;
let contextNode = null;
let crawlAnimationId = null;
let crawlData = null;
let modifyingNodes = new Set(); // nodes currently being modified by AI
let heartbeatNodes = new Map(); // nodeId → { riskLevel, startTime, interval }
let diffScrollAnim = null; // animation for diff scroll
let knownNodeIds = new Set(); // track existing nodes for star-birth detection
let birthAnimations = new Map(); // nodeId → { startTime, spawnPos, targetPos }
let searchActive = false; // true when search input has text
let _searchRAF = null; // RAF loop for search glow animation

// ── File Tree state ──
let fileTreeData = null;           // built tree structure
let fileTreeExpanded = new Set();  // open folder paths
let fileTreeFilter = '';           // search filter
let fileTreeSort = 'name';        // sort mode
let fileTreeModified = new Map();  // path → {type, timestamp}
let fileTreeVisible = true;        // panel visibility
let _fileTreeRenderTimer = null;   // debounce timer
let _treeScrollLock = false;       // manual scroll lock
let _treeScrollLockTimer = null;   // scroll lock timer

let LAYER_HEX = {
  FE: "#00d4ff", BE: "#c084fc", DB: "#ff6b35",
  API: "#00ffaa", CONFIG: "#ffd700", UTIL: "#ff69b4",
};

// ═══════════════════════════════════════════
// SETTINGS SYSTEM
// ═══════════════════════════════════════════
const SETTINGS_DEFAULTS = {
  nodes: {
    sizeMin: 30,
    sizeMultiplier: 3,
    opacity: 1.0,
    resolution: 16,
    selectedColor: "#ffffff",
  },
  links: {
    normalWidth: 1.5,
    highlightWidth: 4.0,
    opacity: 0.9,
    curvatureBase: 0.12,
    normalAlpha: 0.25,
    highlightColor: "#ff2d55",
  },
  particles: {
    normalCount: 6,
    highlightCount: 14,
    normalWidth: 2.0,
    highlightWidth: 4.5,
    normalSpeed: 0.006,
    highlightSpeed: 0.004,
    highlightColor: "#ffffff",
  },
  colors: {
    FE: "#00d4ff",
    BE: "#c084fc",
    DB: "#ff6b35",
    API: "#00ffaa",
    CONFIG: "#ffd700",
    UTIL: "#ff69b4",
  },
  arrows: {
    length: 4,
    position: 1,
  },
  scene: {
    background: "#050a18",
    ambientIntensity: 8,
    pointIntensity: 3,
    pointDistance: 5000,
    fogDensity: 0.00012,
    scanlineOpacity: 1.0,
  },
  camera: {
    initialZ: 3500,
    autoRotateSpeed: 0.0005,
    autoRotateRadius: 1600,
    resetDistance: 1600,
  },
  animation: {
    birthDuration: 2500,
    birthScale: 3,
    spawnX: 5000,
    spawnY: 4000,
    spawnZ: -2000,
  },
  physics: {
    alphaDecay: 0.008,
    velocityDecay: 0.3,
    chargeStrength: -800,
    sameLayerDistance: 250,
    crossLayerDistance: 900,
    clusterStrength: 0.015,
  },
  fileTree: {
    panelWidth: 280,
    fontSize: 11,
    indentSize: 14,
    pulseDuration: 5,
    showLineCount: false,
    showDeps: true,
    showRisk: true,
    autoScrollOnChange: true,
    compactMode: false,
  },
};

function deepMerge(defaults, override) {
  const result = {};
  for (const key of Object.keys(defaults)) {
    if (typeof defaults[key] === "object" && defaults[key] !== null && !Array.isArray(defaults[key])) {
      result[key] = deepMerge(defaults[key], override?.[key] || {});
    } else {
      result[key] = override?.[key] !== undefined ? override[key] : defaults[key];
    }
  }
  return result;
}

function loadSettings() {
  try {
    const stored = JSON.parse(localStorage.getItem("syke-dashboard-settings") || "{}");
    return deepMerge(SETTINGS_DEFAULTS, stored);
  } catch (e) {
    console.warn("[SYKE] Failed to load settings, using defaults", e);
    return deepMerge(SETTINGS_DEFAULTS, {});
  }
}

const SETTINGS = loadSettings();

// Apply colors from settings on startup
Object.assign(LAYER_HEX, SETTINGS.colors);

function saveSettings() {
  try {
    localStorage.setItem("syke-dashboard-settings", JSON.stringify(SETTINGS));
  } catch (e) {
    console.warn("[SYKE] Failed to save settings", e);
  }
}

function resetSettingsGroup(group) {
  if (SETTINGS_DEFAULTS[group]) {
    SETTINGS[group] = deepMerge(SETTINGS_DEFAULTS[group], {});
    saveSettings();
  }
}

function resetAllSettings() {
  for (const group of Object.keys(SETTINGS_DEFAULTS)) {
    SETTINGS[group] = deepMerge(SETTINGS_DEFAULTS[group], {});
  }
  Object.assign(LAYER_HEX, SETTINGS.colors);
  saveSettings();
}

function applySettings(group) {
  if (!Graph) return;
  switch (group) {
    case "nodes":
      refreshGraph();
      break;
    case "links":
      Graph.linkCurvature(link => SETTINGS.links.curvatureBase + (hc(getSrcId(link) + getTgtId(link)) % 20) * 0.01);
      Graph.linkOpacity(SETTINGS.links.opacity);
      refreshGraph();
      break;
    case "particles":
      refreshGraph();
      break;
    case "colors":
      Object.assign(LAYER_HEX, SETTINGS.colors);
      if (graphData) {
        const layerCounts = {};
        graphData.nodes.forEach(n => { layerCounts[n.layer] = (layerCounts[n.layer] || 0) + 1; });
        buildLegend(layerCounts);
      }
      refreshGraph();
      break;
    case "arrows":
      Graph.linkDirectionalArrowLength(SETTINGS.arrows.length);
      Graph.linkDirectionalArrowRelPos(SETTINGS.arrows.position);
      break;
    case "scene":
      Graph.backgroundColor(SETTINGS.scene.background);
      try {
        const scene = Graph.scene();
        if (scene) {
          scene.children.forEach(c => {
            if (c.isAmbientLight) c.intensity = SETTINGS.scene.ambientIntensity;
            if (c.isPointLight) { c.intensity = SETTINGS.scene.pointIntensity; c.distance = SETTINGS.scene.pointDistance; }
          });
          if (scene.fog) scene.fog.density = SETTINGS.scene.fogDensity;
        }
      } catch(e) {}
      const scanline = document.getElementById("scanline");
      if (scanline) scanline.style.opacity = SETTINGS.scene.scanlineOpacity;
      break;
    case "physics":
      Graph.d3AlphaDecay(SETTINGS.physics.alphaDecay);
      Graph.d3VelocityDecay(SETTINGS.physics.velocityDecay);
      try {
        Graph.d3Force("charge").strength(SETTINGS.physics.chargeStrength);
        Graph.d3Force("link")
          .distance(l => srcLayer(l) === tgtLayer(l) ? SETTINGS.physics.sameLayerDistance : SETTINGS.physics.crossLayerDistance);
        Graph.d3Force("cluster", clusterForce(SETTINGS.physics.clusterStrength));
      } catch(e) {}
      Graph.d3ReheatSimulation();
      break;
    case "camera":
      // Camera values are read live in autoRotate loop, no action needed
      break;
    case "animation":
      // Animation values are read when new nodes appear, no action needed
      break;
    case "fileTree":
      applyFileTreeSettings();
      break;
  }
}

function setupSettings() {
  const CTRL_MAP = [
    // [group, key, selector, type]
    ["nodes", "sizeMin", "#set-node-sizeMin", "range"],
    ["nodes", "sizeMultiplier", "#set-node-sizeMultiplier", "range"],
    ["nodes", "opacity", "#set-node-opacity", "range"],
    ["nodes", "resolution", "#set-node-resolution", "range"],
    ["nodes", "selectedColor", "#set-node-selectedColor", "color"],
    ["links", "normalWidth", "#set-link-normalWidth", "range"],
    ["links", "highlightWidth", "#set-link-highlightWidth", "range"],
    ["links", "opacity", "#set-link-opacity", "range"],
    ["links", "curvatureBase", "#set-link-curvatureBase", "range"],
    ["links", "normalAlpha", "#set-link-normalAlpha", "range"],
    ["links", "highlightColor", "#set-link-highlightColor", "color"],
    ["particles", "normalCount", "#set-part-normalCount", "range"],
    ["particles", "highlightCount", "#set-part-highlightCount", "range"],
    ["particles", "normalWidth", "#set-part-normalWidth", "range"],
    ["particles", "highlightWidth", "#set-part-highlightWidth", "range"],
    ["particles", "normalSpeed", "#set-part-normalSpeed", "range"],
    ["particles", "highlightSpeed", "#set-part-highlightSpeed", "range"],
    ["particles", "highlightColor", "#set-part-highlightColor", "color"],
    ["colors", "FE", "#set-color-FE", "color"],
    ["colors", "BE", "#set-color-BE", "color"],
    ["colors", "DB", "#set-color-DB", "color"],
    ["colors", "API", "#set-color-API", "color"],
    ["colors", "CONFIG", "#set-color-CONFIG", "color"],
    ["colors", "UTIL", "#set-color-UTIL", "color"],
    ["arrows", "length", "#set-arrow-length", "range"],
    ["arrows", "position", "#set-arrow-position", "range"],
    ["scene", "background", "#set-scene-background", "color"],
    ["scene", "ambientIntensity", "#set-scene-ambientIntensity", "range"],
    ["scene", "pointIntensity", "#set-scene-pointIntensity", "range"],
    ["scene", "pointDistance", "#set-scene-pointDistance", "range"],
    ["scene", "fogDensity", "#set-scene-fogDensity", "range"],
    ["scene", "scanlineOpacity", "#set-scene-scanlineOpacity", "range"],
    ["camera", "initialZ", "#set-cam-initialZ", "range"],
    ["camera", "autoRotateSpeed", "#set-cam-autoRotateSpeed", "range"],
    ["camera", "autoRotateRadius", "#set-cam-autoRotateRadius", "range"],
    ["camera", "resetDistance", "#set-cam-resetDistance", "range"],
    ["physics", "alphaDecay", "#set-phys-alphaDecay", "range"],
    ["physics", "velocityDecay", "#set-phys-velocityDecay", "range"],
    ["physics", "chargeStrength", "#set-phys-chargeStrength", "range"],
    ["physics", "sameLayerDistance", "#set-phys-sameLayerDistance", "range"],
    ["physics", "crossLayerDistance", "#set-phys-crossLayerDistance", "range"],
    ["physics", "clusterStrength", "#set-phys-clusterStrength", "range"],
    ["animation", "birthDuration", "#set-anim-birthDuration", "range"],
    ["animation", "birthScale", "#set-anim-birthScale", "range"],
    ["animation", "spawnX", "#set-anim-spawnX", "range"],
    ["animation", "spawnY", "#set-anim-spawnY", "range"],
    ["animation", "spawnZ", "#set-anim-spawnZ", "range"],
    ["fileTree", "panelWidth", "#set-ft-panelWidth", "range"],
    ["fileTree", "fontSize", "#set-ft-fontSize", "range"],
    ["fileTree", "indentSize", "#set-ft-indentSize", "range"],
    ["fileTree", "pulseDuration", "#set-ft-pulseDuration", "range"],
    ["fileTree", "showLineCount", "#set-ft-showLineCount", "checkbox"],
    ["fileTree", "showDeps", "#set-ft-showDeps", "checkbox"],
    ["fileTree", "showRisk", "#set-ft-showRisk", "checkbox"],
    ["fileTree", "autoScrollOnChange", "#set-ft-autoScrollOnChange", "checkbox"],
    ["fileTree", "compactMode", "#set-ft-compactMode", "checkbox"],
  ];

  // Init values and bind events
  for (const [group, key, selector, type] of CTRL_MAP) {
    const el = document.querySelector(selector);
    if (!el) continue;
    const valEl = el.parentElement?.querySelector(".set-val");

    if (type === "checkbox") {
      el.checked = !!SETTINGS[group][key];
      el.addEventListener("change", () => {
        SETTINGS[group][key] = el.checked;
        applySettings(group);
        saveSettings();
      });
    } else {
      el.value = SETTINGS[group][key];
      if (valEl) valEl.textContent = formatSetVal(SETTINGS[group][key], type);
      el.addEventListener("input", () => {
        const v = type === "color" ? el.value : parseFloat(el.value);
        SETTINGS[group][key] = v;
        if (valEl) valEl.textContent = formatSetVal(v, type);
        applySettings(group);
        saveSettings();
      });
    }
  }

  // Collapsible sections
  document.querySelectorAll(".set-section-hdr").forEach(hdr => {
    hdr.addEventListener("click", () => {
      const body = hdr.nextElementSibling;
      const arrow = hdr.querySelector(".set-arrow");
      if (body) body.classList.toggle("collapsed");
      if (arrow) arrow.classList.toggle("open");
    });
  });

  // Reset per group
  document.querySelectorAll(".set-rst-btn").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const group = btn.dataset.group;
      resetSettingsGroup(group);
      applySettings(group);
      // Refresh UI inputs
      for (const [g, key, selector, type] of CTRL_MAP) {
        if (g !== group) continue;
        const el = document.querySelector(selector);
        if (!el) continue;
        if (type === "checkbox") { el.checked = !!SETTINGS[group][key]; }
        else { el.value = SETTINGS[group][key]; }
        const valEl = el.parentElement?.querySelector(".set-val");
        if (valEl && type !== "checkbox") valEl.textContent = formatSetVal(SETTINGS[group][key], type);
      }
    });
  });

  // Reset all
  const resetAllBtn = document.getElementById("set-reset-all");
  if (resetAllBtn) {
    resetAllBtn.addEventListener("click", () => {
      resetAllSettings();
      for (const group of Object.keys(SETTINGS_DEFAULTS)) applySettings(group);
      // Refresh all UI inputs
      for (const [group, key, selector, type] of CTRL_MAP) {
        const el = document.querySelector(selector);
        if (!el) continue;
        if (type === "checkbox") { el.checked = !!SETTINGS[group][key]; }
        else { el.value = SETTINGS[group][key]; }
        const valEl = el.parentElement?.querySelector(".set-val");
        if (valEl && type !== "checkbox") valEl.textContent = formatSetVal(SETTINGS[group][key], type);
      }
    });
  }

  // Export
  const exportBtn = document.getElementById("set-export");
  if (exportBtn) {
    exportBtn.addEventListener("click", () => {
      const blob = new Blob([JSON.stringify(SETTINGS, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "syke-settings.json";
      a.click();
      URL.revokeObjectURL(url);
    });
  }

  // Import
  const importBtn = document.getElementById("set-import");
  if (importBtn) {
    importBtn.addEventListener("click", () => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = ".json";
      input.addEventListener("change", () => {
        const file = input.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
          try {
            const imported = JSON.parse(reader.result);
            const merged = deepMerge(SETTINGS_DEFAULTS, imported);
            for (const group of Object.keys(merged)) {
              SETTINGS[group] = merged[group];
            }
            Object.assign(LAYER_HEX, SETTINGS.colors);
            saveSettings();
            for (const group of Object.keys(SETTINGS_DEFAULTS)) applySettings(group);
            // Refresh all UI inputs
            for (const [group, key, selector, type] of CTRL_MAP) {
              const el = document.querySelector(selector);
              if (!el) continue;
              if (type === "checkbox") { el.checked = !!SETTINGS[group][key]; }
              else { el.value = SETTINGS[group][key]; }
              const valEl = el.parentElement?.querySelector(".set-val");
              if (valEl && type !== "checkbox") valEl.textContent = formatSetVal(SETTINGS[group][key], type);
            }
          } catch(e) {
            console.error("[SYKE] Import failed:", e);
          }
        };
        reader.readAsText(file);
      });
      input.click();
    });
  }

  // Apply scanline opacity on startup
  const scanline = document.getElementById("scanline");
  if (scanline) scanline.style.opacity = SETTINGS.scene.scanlineOpacity;
}

function formatSetVal(v, type) {
  if (type === "color") return v;
  if (Number.isInteger(v)) return v.toString();
  if (Math.abs(v) < 0.01) return v.toFixed(5);
  if (Math.abs(v) < 1) return v.toFixed(3);
  return v.toFixed(1);
}

const LAYER_KEYS = ["FE", "BE", "DB", "API", "CONFIG", "UTIL"];

const LAYER_CENTERS = {
  FE:     { x: -2500, y:  1000, z: -1000 },
  BE:     { x:  2500, y:  1000, z:  1000 },
  DB:     { x:     0, y: -2200, z:  1800 },
  API:    { x:  2200, y: -1200, z: -1800 },
  CONFIG: { x: -2200, y:  2500, z:  1500 },
  UTIL:   { x:     0, y:   200, z:     0 },
};

// ═══════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════
document.addEventListener("DOMContentLoaded", async () => {
  console.log("[SYKE] init v2.1");
  await loadProjectInfo();
  await loadGraph();
  await loadHubFiles();
  setupEventListeners();
  setupKeyboardShortcuts();
  setupContextMenu();
  setupTabs();
  setupSettings();
  setupProjectModal();
  setupLicenseModal();
  setupAIKeysModal();
  setupAIProviderSelector();
  setupFileTree();
  initSSE();
  startHealthCheck();
});

// Periodic server health check (catches server down even without SSE)
let healthCheckTimer = null;
let healthFailCount = 0;
const HEALTH_FAIL_THRESHOLD = 3; // Show offline only after 3 consecutive failures
function startHealthCheck() {
  if (healthCheckTimer) return;
  healthCheckTimer = setInterval(async () => {
    try {
      const res = await fetch("/api/project-info", { signal: AbortSignal.timeout(10000) });
      if (res.ok) {
        healthFailCount = 0; // Reset on success
      }
    } catch (e) {
      healthFailCount++;
      if (healthFailCount >= HEALTH_FAIL_THRESHOLD) {
        showServerOffline();
      }
    }
  }, 30000); // Check every 30 seconds (not 10)
}

// ═══════════════════════════════════════════
// WELCOME OVERLAY
// ═══════════════════════════════════════════
function showWelcomeOverlay() {
  const overlay = document.getElementById("welcome-overlay");
  if (overlay) overlay.classList.remove("hidden");

  const btn = document.getElementById("btn-welcome-open");
  if (btn && !btn._bound) {
    btn.addEventListener("click", () => {
      document.getElementById("btn-change-project").click();
    });
    btn._bound = true;
  }
}

function hideWelcomeOverlay() {
  const overlay = document.getElementById("welcome-overlay");
  if (overlay) overlay.classList.add("hidden");
}

// ═══════════════════════════════════════════
// GRAPH LOADING
// ═══════════════════════════════════════════
async function loadGraph() {
  const res = await fetch("/api/graph");
  const raw = await res.json();
  console.log("[SYKE]", raw.nodes.length, "nodes", raw.edges.length, "edges");

  if (raw.nodes.length === 0) {
    showWelcomeOverlay();
    return;
  }
  hideWelcomeOverlay();

  const isReload = Graph !== null;

  // Spawn point for new nodes (top-right corner of 3D space)
  const SPAWN = { x: SETTINGS.animation.spawnX, y: SETTINGS.animation.spawnY, z: SETTINGS.animation.spawnZ };

  // Preserve existing node positions on reload
  const currentPositions = {};
  if (isReload) {
    const cur = Graph.graphData();
    cur.nodes.forEach(n => {
      currentPositions[n.id] = { x: n.x, y: n.y, z: n.z };
    });
  }

  const nodes = raw.nodes.map(n => {
    const layer = n.data.layer || "UTIL";
    const c = LAYER_CENTERS[layer] || LAYER_CENTERS.UTIL;
    const isNew = knownNodeIds.size > 0 && !knownNodeIds.has(n.data.id);

    // For existing nodes on reload: keep their current simulated position
    const targetPos = currentPositions[n.data.id] || {
      x: c.x + (Math.random() - 0.5) * 600,
      y: c.y + (Math.random() - 0.5) * 600,
      z: c.z + (Math.random() - 0.5) * 600,
    };

    // New node: spawn from far corner, will animate to target
    if (isNew) {
      console.log("[SYKE] ★ Star birth:", n.data.id);
      birthAnimations.set(n.data.id, {
        startTime: Date.now(),
        spawnPos: { ...SPAWN },
        targetPos: { ...targetPos },
        duration: SETTINGS.animation.birthDuration,
      });
    }

    return {
      id: n.data.id, label: n.data.label, fullPath: n.data.fullPath,
      riskLevel: n.data.riskLevel, dependentCount: n.data.dependentCount,
      lineCount: n.data.lineCount || 0, importsCount: n.data.importsCount || 0,
      depth: n.data.depth || 0, group: n.data.group,
      layer, action: n.data.action || "X", env: n.data.env || "PROD",
      x: isNew ? SPAWN.x : targetPos.x,
      y: isNew ? SPAWN.y : targetPos.y,
      z: isNew ? SPAWN.z : targetPos.z,
      // Pin new nodes at SPAWN so simulation doesn't skip their animation
      fx: isNew ? SPAWN.x : undefined,
      fy: isNew ? SPAWN.y : undefined,
      fz: isNew ? SPAWN.z : undefined,
      _isNew: isNew,
    };
  });

  // Update known node IDs
  knownNodeIds = new Set(nodes.map(n => n.id));
  const links = raw.edges.map(e => ({ source: e.data.source, target: e.data.target }));
  graphData = { nodes, links };

  const layerCounts = {};
  nodes.forEach(n => { layerCounts[n.layer] = (layerCounts[n.layer] || 0) + 1; });

  document.getElementById("stat-files").textContent = nodes.length;
  document.getElementById("stat-edges").textContent = links.length;
  const highRisk = nodes.filter(n => n.riskLevel === "HIGH").length;
  document.getElementById("stat-high").textContent = highRisk;

  // ── RELOAD: just update data, no graph re-creation ──
  if (isReload) {
    Graph.graphData(graphData);
    buildLegend(layerCounts);
    renderFileTreeDebounced();
    console.log("[SYKE] Graph updated (reload), birth animations:", birthAnimations.size);

    // ── Star birth camera choreography ──
    if (birthAnimations.size > 0) {
      const firstBirth = birthAnimations.values().next().value;
      const sp = firstBirth.spawnPos;
      const tp = firstBirth.targetPos;
      stopUser(); // stop auto-rotate

      // Phase 1: Zoom in to spawn point (close-up, 800ms)
      Graph.cameraPosition(
        { x: sp.x + 300, y: sp.y + 200, z: sp.z + 600 },
        { x: sp.x, y: sp.y, z: sp.z },
        800
      );

      // Phase 2: Follow node to target with rotation (at 1.2s, 2s transition)
      setTimeout(() => {
        Graph.cameraPosition(
          { x: tp.x + 400, y: tp.y + 300, z: tp.z + 500 },
          { x: tp.x, y: tp.y, z: tp.z },
          2000
        );
      }, 1200);

      // Phase 3: Zoom out to overview (at 3.5s, 1.5s transition)
      setTimeout(() => {
        Graph.cameraPosition(
          { x: 0, y: 0, z: SETTINGS.camera.initialZ },
          { x: 0, y: 0, z: 0 },
          1500
        );
        // Resume auto-rotate
        setTimeout(() => {
          autoRotate = true;
          document.getElementById("btn-auto-rotate").classList.add("active");
          startAutoRotate();
        }, 1800);
      }, 3500);
    }
    return;
  }

  // ── FIRST LOAD: create new Graph instance ──
  const container = document.getElementById("3d-graph");

  Graph = ForceGraph3D()(container)
    .width(getGraphPanelWidth())
    .height(window.innerHeight - 100)
    .graphData(graphData)
    .backgroundColor(SETTINGS.scene.background)
    .showNavInfo(false)

    .nodeColor(node => getNodeColor(node))
    .nodeVal(node => {
      if (!isNodeVisible(node)) return 0.001;
      const base = Math.max(SETTINGS.nodes.sizeMin, Math.sqrt(node.lineCount) * SETTINGS.nodes.sizeMultiplier);
      // Search mode: shrink non-matches, boost matches
      if (searchActive) {
        if (!highlightNodes.has(node.id)) return base * 0.3;
        const pulse = 0.9 + 0.1 * Math.sin(Date.now() / 400);
        return base * 1.4 * pulse;
      }
      const hb = heartbeatNodes.get(node.id);
      if (hb) {
        const elapsed = Date.now() - hb.startTime;
        const period = hb.riskLevel === "CRITICAL" ? 400 : hb.riskLevel === "HIGH" ? 600 : 900;
        const t = (elapsed % period) / period;
        const spike = Math.max(0, 1 - Math.abs(t - 0.15) * 10, 1 - Math.abs(t - 0.35) * 12);
        return base * (1 + spike * 0.6);
      }
      if (modifyingNodes.has(node.id)) {
        const pulse = 0.5 + 0.5 * Math.sin(Date.now() / 200);
        return base * (1 + pulse * 0.4);
      }
      // Star birth: start large, shrink to normal
      const birth = birthAnimations.get(node.id);
      if (birth) {
        const t = Math.min(1, (Date.now() - birth.startTime) / birth.duration);
        if (t >= 1) birthAnimations.delete(node.id);
        const scale = 1 + (SETTINGS.animation.birthScale - 1) * (1 - t) * (1 - t); // ease-out: Nx → 1x
        return base * scale;
      }
      return base;
    })
    .nodeOpacity(SETTINGS.nodes.opacity)
    .nodeResolution(SETTINGS.nodes.resolution)
    .nodeVisibility(node => isNodeVisible(node))
    .nodeLabel(node => {
      const c = LAYER_HEX[node.layer] || "#ccc";
      return `<div style="background:rgba(5,10,24,0.95);border:1px solid ${c};padding:6px 12px;border-radius:3px;font-family:Consolas,monospace;font-size:12px;color:#fff;text-shadow:none">
        <span style="color:${c};font-weight:700">[${node.layer}]</span> ${node.fullPath}<br>
        <span style="color:${c}">${node.lineCount} lines</span> &middot; ${node.dependentCount} deps &middot; depth ${node.depth} &middot; ${node.importsCount} imports &middot; ${node.riskLevel}
      </div>`;
    })

    .linkColor(link => getLinkColor(link))
    .linkWidth(link => highlightLinks.has(link) ? SETTINGS.links.highlightWidth : SETTINGS.links.normalWidth)
    .linkOpacity(SETTINGS.links.opacity)
    .linkVisibility(link => isLinkVisible(link))
    .linkCurvature(link => SETTINGS.links.curvatureBase + (hc(getSrcId(link) + getTgtId(link)) % 20) * 0.01)
    .linkCurveRotation(link => (hc(getTgtId(link) + getSrcId(link)) % 628) / 100)

    .linkDirectionalParticles(link => {
      if (searchActive) return highlightLinks.has(link) ? SETTINGS.particles.highlightCount : 0;
      if (highlightLinks.has(link)) return SETTINGS.particles.highlightCount;
      const isActive = modifyingNodes.size > 0 || heartbeatNodes.size > 0;
      return isActive ? Math.round(SETTINGS.particles.normalCount * 0.67) : SETTINGS.particles.normalCount;
    })
    .linkDirectionalParticleWidth(link => {
      if (highlightLinks.has(link)) return SETTINGS.particles.highlightWidth;
      const isActive = modifyingNodes.size > 0 || heartbeatNodes.size > 0;
      return isActive ? SETTINGS.particles.normalWidth * 0.75 : SETTINGS.particles.normalWidth;
    })
    .linkDirectionalParticleSpeed(link => highlightLinks.has(link) ? SETTINGS.particles.highlightSpeed : SETTINGS.particles.normalSpeed)
    .linkDirectionalParticleColor(link => {
      if (searchActive && highlightLinks.has(link)) return LAYER_HEX[srcLayer(link)] || "#00d4ff";
      if (highlightLinks.has(link)) return SETTINGS.particles.highlightColor;
      const isActive = modifyingNodes.size > 0 || heartbeatNodes.size > 0;
      if (isActive) return "rgba(150,180,220,0.6)";
      return LAYER_HEX[srcLayer(link)] || "#ff69b4";
    })

    .linkDirectionalArrowLength(SETTINGS.arrows.length)
    .linkDirectionalArrowRelPos(SETTINGS.arrows.position)
    .linkDirectionalArrowColor(link => {
      if (highlightLinks.has(link)) return SETTINGS.links.highlightColor;
      return rgba(LAYER_HEX[srcLayer(link)] || "#ff69b4", 0.4);
    })

    .onNodeClick(node => {
      if (pathMode) { handlePathNodeClick(node); return; }
      handleNodeClick(node);
    })
    .onNodeHover(node => handleNodeHover(node))
    .onNodeRightClick((node, event) => showContextMenu(node, event))
    .onBackgroundClick(() => { hideContextMenu(); handleBackgroundClick(); })
    .onBackgroundRightClick(() => hideContextMenu())

    .enableNodeDrag(true)
    .onNodeDrag(node => { stopUser(); })
    .onNodeDragEnd(node => {
      node.fx = undefined;
      node.fy = undefined;
      node.fz = undefined;
    })

    // Star birth: animate pinned position from SPAWN → target on each tick
    .onEngineTick(() => {
      if (birthAnimations.size === 0) return;
      const now = Date.now();
      for (const [nodeId, anim] of birthAnimations) {
        const node = graphData.nodes.find(n => n.id === nodeId);
        if (!node) continue;
        const t = Math.min(1, (now - anim.startTime) / anim.duration);
        if (t < 1) {
          // Ease-out cubic: fast start, gentle landing
          const ease = 1 - Math.pow(1 - t, 3);
          node.fx = anim.spawnPos.x + (anim.targetPos.x - anim.spawnPos.x) * ease;
          node.fy = anim.spawnPos.y + (anim.targetPos.y - anim.spawnPos.y) * ease;
          node.fz = anim.spawnPos.z + (anim.targetPos.z - anim.spawnPos.z) * ease;
        } else {
          // Animation done: unpin, let simulation fine-tune position
          node.fx = undefined;
          node.fy = undefined;
          node.fz = undefined;
          birthAnimations.delete(nodeId);
          console.log("[SYKE] ★ Star birth complete:", nodeId);
        }
      }
    })

    .d3AlphaDecay(SETTINGS.physics.alphaDecay)
    .d3VelocityDecay(SETTINGS.physics.velocityDecay)
    .warmupTicks(300)
    .cooldownTicks(800)
    .enablePointerInteraction(true);

  Graph.d3Force("cluster", clusterForce(SETTINGS.physics.clusterStrength));
  Graph.d3Force("charge").strength(SETTINGS.physics.chargeStrength);
  Graph.d3Force("link")
    .distance(l => srcLayer(l) === tgtLayer(l) ? SETTINGS.physics.sameLayerDistance : SETTINGS.physics.crossLayerDistance)
    .strength(l => srcLayer(l) === tgtLayer(l) ? 0.2 : 0.05);

  Graph.cameraPosition({ x: 0, y: 0, z: SETTINGS.camera.initialZ });

  setTimeout(() => {
    try {
      const scene = Graph.scene();
      if (!scene) return;
      scene.add(new THREE.AmbientLight(0xffffff, SETTINGS.scene.ambientIntensity));
      const ptLight = new THREE.PointLight(0xffffff, SETTINGS.scene.pointIntensity, SETTINGS.scene.pointDistance);
      scene.add(ptLight);
      scene.fog = new THREE.FogExp2(parseInt(SETTINGS.scene.background.replace("#",""), 16), SETTINGS.scene.fogDensity);
      console.log("[SYKE] Scene ready");
    } catch(e) { console.warn(e); }
  }, 500);

  setTimeout(() => {
    autoRotate = true;
    document.getElementById("btn-auto-rotate").classList.add("active");
    startAutoRotate();
  }, 3500);

  container.addEventListener("wheel", stopUser);
  container.addEventListener("mousedown", stopUser);
  container.addEventListener("touchstart", stopUser);

  window.addEventListener("resize", () => {
    if (Graph) Graph.width(getGraphPanelWidth()).height(window.innerHeight - 100);
  });

  buildLegend(layerCounts);
  renderFileTreeDebounced();
  createNodeLabels();
  updateLabelsLoop();

  // ── Auto-start code crawl with highest-hub file on initial load ──
  setTimeout(() => {
    const topNode = nodes.slice().sort((a, b) => b.dependentCount - a.dependentCount)[0];
    if (topNode) startCodeCrawl(topNode.id);
  }, 2000);
}

// ═══════════════════════════════════════════
// VISIBILITY FILTERS
// ═══════════════════════════════════════════
function isNodeVisible(node) {
  if (hiddenLayers.has(node.layer)) return false;
  if (hiddenNodes.has(node.id)) return false;
  return true;
}

function isLinkVisible(link) {
  const src = getNodeById(getSrcId(link));
  const tgt = getNodeById(getTgtId(link));
  if (!src || !tgt) return false;
  return isNodeVisible(src) && isNodeVisible(tgt);
}

function getNodeById(id) {
  return graphData.nodes.find(n => n.id === id);
}

// ═══════════════════════════════════════════
// HTML NODE LABELS
// ═══════════════════════════════════════════
function createNodeLabels() {
  const container = document.getElementById("node-labels");
  container.innerHTML = "";
  graphData.nodes.forEach(node => {
    const el = document.createElement("div");
    el.className = "node-lbl";
    el.id = "lbl-" + node.id.replace(/[\/\\.]/g, "_");
    const col = LAYER_HEX[node.layer] || "#00d4ff";
    el.style.borderColor = col;
    el.innerHTML = `<span style="color:${col}">${node.lineCount}L</span> ${node.dependentCount}D` +
      `<br><span class="lbl-dim">dp${node.depth} im${node.importsCount}</span>`;
    container.appendChild(el);
  });
}

function updateLabelsLoop() {
  if (!Graph) return;
  const graphRect = document.getElementById("graph-panel").getBoundingClientRect();

  graphData.nodes.forEach(node => {
    const el = document.getElementById("lbl-" + node.id.replace(/[\/\\.]/g, "_"));
    if (!el) return;

    if (!isNodeVisible(node)) { el.style.display = "none"; return; }

    const coords = Graph.graph2ScreenCoords(node.x || 0, node.y || 0, node.z || 0);
    if (!coords) { el.style.display = "none"; return; }

    const sx = coords.x;
    const sy = coords.y;

    if (sx < -50 || sx > graphRect.width + 50 || sy < -50 || sy > graphRect.height + 50) {
      el.style.display = "none";
    } else {
      el.style.display = "";
      el.style.left = sx + "px";
      el.style.top = (sy - 18) + "px";

      if (highlightNodes.size > 0 && !highlightNodes.has(node.id)) {
        const isActive = modifyingNodes.size > 0 || heartbeatNodes.size > 0;
        el.style.opacity = isActive ? "0.06" : "0.15";
      } else {
        el.style.opacity = "1";
      }
    }
  });

  requestAnimationFrame(updateLabelsLoop);
}

// ═══════════════════════════════════════════
// COLORS
// ═══════════════════════════════════════════
function getNodeColor(node) {
  // Heartbeat pulse: connected nodes pulsing by risk level
  const hb = heartbeatNodes.get(node.id);
  if (hb) {
    const elapsed = Date.now() - hb.startTime;
    // Heartbeat: sharp spike then fade, like a real heartbeat
    const period = hb.riskLevel === "CRITICAL" ? 400 : hb.riskLevel === "HIGH" ? 600 : 900;
    const t = (elapsed % period) / period;
    // Double-spike heartbeat waveform
    const spike1 = Math.max(0, 1 - Math.abs(t - 0.15) * 10);
    const spike2 = Math.max(0, 1 - Math.abs(t - 0.35) * 12);
    const beat = Math.max(spike1, spike2);

    const colors = {
      CRITICAL: [255, 0, 40],
      HIGH: [255, 45, 85],
      MEDIUM: [255, 159, 10],
      LOW: [48, 209, 88],
      SAFE: [48, 209, 88],
    };
    const [cr, cg, cb] = colors[hb.riskLevel] || colors.MEDIUM;
    const base = LAYER_HEX[node.layer] || "#ff69b4";
    const br = parseInt(base.slice(1,3),16);
    const bg = parseInt(base.slice(3,5),16);
    const bb = parseInt(base.slice(5,7),16);
    const r = Math.round(br + (cr - br) * beat);
    const g = Math.round(bg + (cg - bg) * beat);
    const b = Math.round(bb + (cb - bb) * beat);
    return `rgb(${r},${g},${b})`;
  }

  // Star birth: bright white → cyan → normal layer color
  const birth = birthAnimations.get(node.id);
  if (birth) {
    const t = Math.min(1, (Date.now() - birth.startTime) / birth.duration);
    const layerHex = LAYER_HEX[node.layer] || "#ff69b4";
    const lr = parseInt(layerHex.slice(1,3),16);
    const lg = parseInt(layerHex.slice(3,5),16);
    const lb = parseInt(layerHex.slice(5,7),16);
    if (t < 0.3) {
      // Phase 1: white → cyan flash
      const p = t / 0.3;
      return `rgb(${Math.round(255*(1-p))},${255},${255})`;
    } else {
      // Phase 2: cyan → normal layer color (smooth blend)
      const p = (t - 0.3) / 0.7;
      const ease = p * p; // ease-in for gentle arrival
      return `rgb(${Math.round(lr*ease)},${Math.round(255+(lg-255)*ease)},${Math.round(255+(lb-255)*ease)})`;
    }
  }

  // AI is modifying this node → bright pulsing white/orange
  if (modifyingNodes.has(node.id)) {
    const t = Date.now() / 200;
    const pulse = 0.5 + 0.5 * Math.sin(t);
    return `rgb(255,${Math.round(180 + pulse * 75)},${Math.round(50 + pulse * 50)})`;
  }
  if (node.id === selectedNodeId) return SETTINGS.nodes.selectedColor;
  const base = LAYER_HEX[node.layer] || "#ff69b4";
  if (highlightNodes.size > 0 && !highlightNodes.has(node.id)) {
    if (searchActive) {
      // Search mode: near-invisible ghost nodes
      return dimHex(base, 0.06);
    }
    const isActive = modifyingNodes.size > 0 || heartbeatNodes.size > 0;
    return dimHex(base, isActive ? 0.12 : 0.35);
  }
  // Search match: pulsing bright glow
  if (searchActive && highlightNodes.has(node.id)) {
    const pulse = 0.85 + 0.15 * Math.sin(Date.now() / 300);
    const r = Math.min(255, Math.round(parseInt(base.slice(1,3),16) * pulse + 40));
    const g = Math.min(255, Math.round(parseInt(base.slice(3,5),16) * pulse + 40));
    const b = Math.min(255, Math.round(parseInt(base.slice(5,7),16) * pulse + 40));
    return `rgb(${r},${g},${b})`;
  }
  return base;
}

// Start heartbeat on connected nodes with risk-based coloring
function startHeartbeat(nodeIds, riskLevel) {
  const now = Date.now();
  for (const id of nodeIds) {
    heartbeatNodes.set(id, { riskLevel, startTime: now });
  }
  // Ensure continuous visual refresh for heartbeat
  if (!window._heartbeatRAF) {
    function heartbeatLoop() {
      if (heartbeatNodes.size > 0 && Graph) {
        Graph.nodeColor(Graph.nodeColor());
        Graph.nodeVal(Graph.nodeVal());
      }
      window._heartbeatRAF = requestAnimationFrame(heartbeatLoop);
    }
    heartbeatLoop();
  }
}

function stopHeartbeat(nodeIds) {
  for (const id of nodeIds) {
    heartbeatNodes.delete(id);
  }
  if (heartbeatNodes.size === 0 && window._heartbeatRAF) {
    cancelAnimationFrame(window._heartbeatRAF);
    window._heartbeatRAF = null;
    // Restore normal brightness when all heartbeats done
    refreshGraph();
  }
}

function stopAllHeartbeats() {
  heartbeatNodes.clear();
  if (window._heartbeatRAF) {
    cancelAnimationFrame(window._heartbeatRAF);
    window._heartbeatRAF = null;
  }
}

// Focus camera on a specific node (smooth transition)
function focusCameraOnNode(nodeId) {
  const node = graphData?.nodes.find(n => n.id === nodeId);
  if (!node || !Graph) return;
  stopUser(); // stop auto-rotate
  const nx = node.x || 0, ny = node.y || 0, nz = node.z || 0;
  const d = Math.max(1, Math.hypot(nx, ny, nz));
  Graph.cameraPosition(
    { x: nx + 200 * nx / d, y: ny + 200 * ny / d, z: nz + 200 * nz / d },
    { x: nx, y: ny, z: nz },
    1200
  );
}

function dimHex(hex, factor) {
  const r = Math.round(parseInt(hex.slice(1,3),16) * factor);
  const g = Math.round(parseInt(hex.slice(3,5),16) * factor);
  const b = Math.round(parseInt(hex.slice(5,7),16) * factor);
  return `#${r.toString(16).padStart(2,"0")}${g.toString(16).padStart(2,"0")}${b.toString(16).padStart(2,"0")}`;
}

function getLinkColor(link) {
  if (searchActive && highlightLinks.has(link)) {
    // Search mode: matched links glow with source layer color
    return LAYER_HEX[srcLayer(link)] || "#00d4ff";
  }
  if (highlightLinks.has(link)) return SETTINGS.links.highlightColor;
  if (highlightNodes.size > 0 && !highlightLinks.has(link)) {
    if (searchActive) return "rgba(30,40,60,0.02)"; // near-invisible
    const isActive = modifyingNodes.size > 0 || heartbeatNodes.size > 0;
    return isActive ? "rgba(60,70,90,0.03)" : "rgba(100,120,150,0.06)";
  }
  return rgba(LAYER_HEX[srcLayer(link)] || "#ff69b4", SETTINGS.links.normalAlpha);
}

// ═══════════════════════════════════════════
// CLUSTER FORCE
// ═══════════════════════════════════════════
function clusterForce(str) {
  const f = (alpha) => {
    if (!graphData) return;
    const k = alpha * str;
    for (const n of graphData.nodes) {
      const c = LAYER_CENTERS[n.layer] || LAYER_CENTERS.UTIL;
      if (n.x != null) n.vx = (n.vx || 0) + (c.x - n.x) * k;
      if (n.y != null) n.vy = (n.vy || 0) + (c.y - n.y) * k;
      if (n.z != null) n.vz = (n.vz || 0) + (c.z - n.z) * k;
    }
  };
  f.initialize = () => {};
  return f;
}

// ═══════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════
function getSrcId(l) { return (typeof l.source === "object" && l.source) ? l.source.id : l.source; }
function getTgtId(l) { return (typeof l.target === "object" && l.target) ? l.target.id : l.target; }
function srcLayer(l) { const n = graphData.nodes.find(x => x.id === getSrcId(l)); return n ? n.layer : "UTIL"; }
function tgtLayer(l) { const n = graphData.nodes.find(x => x.id === getTgtId(l)); return n ? n.layer : "UTIL"; }
function hc(s) { let h=0; for(let i=0;i<s.length;i++){h=((h<<5)-h)+s.charCodeAt(i);h|=0;} return Math.abs(h); }
function rgba(hex,a) { return `rgba(${parseInt(hex.slice(1,3),16)},${parseInt(hex.slice(3,5),16)},${parseInt(hex.slice(5,7),16)},${a})`; }

// ═══════════════════════════════════════════
// LEGEND (clickable layer filter)
// ═══════════════════════════════════════════
function buildLegend(counts) {
  const el = document.getElementById("layer-legend");
  if (!el) return;
  let h = "";
  Object.entries(LAYER_HEX).forEach(([layer, color]) => {
    const c = counts[layer] || 0;
    if (!c) return;
    const filtered = hiddenLayers.has(layer) ? " filtered" : "";
    h += `<div class="legend-item${filtered}" data-layer="${layer}">
      <span class="legend-dot" style="background:${color};box-shadow:0 0 10px ${color}"></span>
      <span class="legend-label" style="color:${color}">${layer}</span>
      <span class="legend-count">${c}</span></div>`;
  });
  el.innerHTML = h;
  el.querySelectorAll(".legend-item").forEach(item => {
    item.addEventListener("click", (e) => {
      if (e.shiftKey) {
        // Shift+click: isolate this layer only
        const layer = item.dataset.layer;
        const allHidden = LAYER_KEYS.every(l => l === layer || hiddenLayers.has(l));
        if (allHidden) {
          // All others hidden → show all
          hiddenLayers.clear();
        } else {
          hiddenLayers.clear();
          LAYER_KEYS.forEach(l => { if (l !== layer) hiddenLayers.add(l); });
        }
      } else {
        // Regular click: toggle this layer
        const layer = item.dataset.layer;
        if (hiddenLayers.has(layer)) {
          hiddenLayers.delete(layer);
        } else {
          hiddenLayers.add(layer);
        }
      }
      // Update legend visual
      el.querySelectorAll(".legend-item").forEach(li => {
        li.classList.toggle("filtered", hiddenLayers.has(li.dataset.layer));
      });
      refreshGraph();
    });
  });
}

// ═══════════════════════════════════════════
// AUTO-ROTATE
// ═══════════════════════════════════════════
let rotAngle = 0, rotRAF = null;
function startAutoRotate() {
  if (!autoRotate || !Graph) return;
  rotAngle += SETTINGS.camera.autoRotateSpeed;
  Graph.cameraPosition({
    x: SETTINGS.camera.autoRotateRadius * Math.sin(rotAngle),
    y: 200 + Math.sin(rotAngle * 0.3) * 100,
    z: SETTINGS.camera.autoRotateRadius * Math.cos(rotAngle),
  });
  rotRAF = requestAnimationFrame(startAutoRotate);
}
function stopAutoRotate() { if (rotRAF) { cancelAnimationFrame(rotRAF); rotRAF = null; } }
function stopUser() {
  if (autoRotate) {
    autoRotate = false; stopAutoRotate();
    document.getElementById("btn-auto-rotate").classList.remove("active");
  }
}

// ═══════════════════════════════════════════
// HOVER
// ═══════════════════════════════════════════
function handleNodeHover(node) {
  const tt = document.getElementById("node-tooltip");
  if (node) {
    document.getElementById("3d-graph").style.cursor = pathMode ? "crosshair" : "pointer";
    tt.classList.remove("hidden");
    const c = LAYER_HEX[node.layer] || "#ccc";
    tt.innerHTML = `<span style="color:${c};font-weight:700">[${node.layer}]</span> ${node.fullPath} <span style="color:${c}">${node.lineCount}L</span> ${node.dependentCount}D`;
  } else {
    document.getElementById("3d-graph").style.cursor = pathMode ? "crosshair" : "grab";
    tt.classList.add("hidden");
  }
}
document.addEventListener("mousemove", e => {
  const t = document.getElementById("node-tooltip");
  if (!t.classList.contains("hidden")) { t.style.left=(e.clientX+16)+"px"; t.style.top=(e.clientY-10)+"px"; }
});

// ═══════════════════════════════════════════
// CLICK HANDLING
// ═══════════════════════════════════════════
async function handleNodeClick(node) {
  if (!node) return;
  hideContextMenu();
  selectedFile = node.id; selectedNodeId = node.id;
  stopUser();
  try {
    const nx=node.x||0, ny=node.y||0, nz=node.z||0;
    const d = Math.max(1, Math.hypot(nx,ny,nz));
    Graph.cameraPosition(
      { x: nx+150*nx/d, y: ny+150*ny/d, z: nz+150*nz/d },
      { x: nx, y: ny, z: nz }, 1200
    );
  } catch(e) {}
  refreshGraph();
  await showImpact(node.id, node);
  // Auto-load code preview
  loadCodePreview(node.id);
  // Auto-load simulation
  loadSimulation(node.id);
  // Start Star Wars code crawl
  startCodeCrawl(node.id);
  // Sync file tree selection
  treeScrollToFile(node.id);
}

function handleBackgroundClick() {
  selectedFile = null; selectedNodeId = null;
  highlightNodes.clear(); highlightLinks.clear();
  document.getElementById("file-info-content").innerHTML = '<p class="placeholder">Select a node to identify target</p>';
  document.getElementById("impact-content").innerHTML = '<p class="placeholder">Select a node to trace impact chain</p>';
  document.getElementById("ai-content").innerHTML = '<p class="placeholder">Select target, then request AI analysis</p>';
  document.getElementById("code-content").innerHTML = '<p class="placeholder">Select a node to preview source code</p>';
  document.getElementById("sim-content").innerHTML = '<p class="placeholder">Select a node, then switch to SIM tab</p>';
  document.getElementById("btn-ai-analyze").disabled = true;
  // Don't stop code crawl — keep it always visible
  refreshGraph();
}

// ═══════════════════════════════════════════
// IMPACT ANALYSIS
// ═══════════════════════════════════════════
async function showImpact(fileId, nd) {
  const col = LAYER_HEX[nd.layer] || "#999";
  document.getElementById("file-info-content").innerHTML = `
    <div class="file-detail"><span class="label">PATH </span><span class="value">${nd.fullPath||fileId}</span></div>
    <div class="file-detail"><span class="label">LAYER </span><span class="layer-badge" style="color:${col};border-color:${col}">${nd.layer}</span>
      &nbsp;<span class="label">LINES </span><span class="value">${nd.lineCount}</span>
      &nbsp;<span class="label">ACTION </span><span class="value">${nd.action}</span></div>
    <div class="file-detail"><span class="label">RISK </span><span class="risk-badge ${nd.riskLevel}">${nd.riskLevel}</span>
      &nbsp;<span class="label">DEPS </span><span class="value">${nd.dependentCount}</span>
      &nbsp;<span class="label">DEPTH </span><span class="value">${nd.depth}</span>
      &nbsp;<span class="label">IMPORTS </span><span class="value">${nd.importsCount}</span></div>`;
  document.getElementById("btn-ai-analyze").disabled = false;
  document.getElementById("ai-content").innerHTML = '<p class="placeholder">Click ANALYZE for AI intel</p>';
  document.getElementById("impact-content").innerHTML = '<div class="loading"><div class="spinner"></div>TRACING...</div>';

  try {
    const res = await fetch("/api/impact/" + fileId.split("/").map(encodeURIComponent).join("/"));
    const ct = res.headers.get("content-type") || "";
    if (!ct.includes("application/json")) {
      document.getElementById("impact-content").innerHTML = `<p class="placeholder">ERROR: Server returned non-JSON (${res.status})</p>`;
      return;
    }
    const impact = await res.json();
    if (!res.ok) { document.getElementById("impact-content").innerHTML = `<p class="placeholder">ERROR: ${impact.error}</p>`; return; }

    highlightNodes.clear(); highlightLinks.clear(); highlightNodes.add(fileId);
    if (impact.directDependents) impact.directDependents.forEach(d => highlightNodes.add(d));
    if (impact.transitiveDependents) impact.transitiveDependents.forEach(t => highlightNodes.add(t));
    graphData.links.forEach(l => {
      if (highlightNodes.has(getSrcId(l)) && highlightNodes.has(getTgtId(l))) highlightLinks.add(l);
    });
    refreshGraph();

    let html = `<div class="file-detail"><span class="label">IMPACTED </span><span class="value" style="color:#ff2d55">${impact.totalImpacted}</span></div>`;
    if (impact.directDependents && impact.directDependents.length > 0) {
      html += `<div style="margin-top:10px;font-size:10px;color:#ff2d55;font-weight:600;letter-spacing:2px">DIRECT (${impact.directDependents.length})</div>`;
      for (const d of impact.directDependents) {
        const dn = graphData.nodes.find(n => n.id === d);
        const dc = dn ? LAYER_HEX[dn.layer]||"#999" : "#999";
        html += `<div class="impact-item direct" data-file="${d}"><span style="color:${dc};margin-right:4px">[${dn?dn.layer:"?"}]</span>${d}</div>`;
      }
    }
    if (impact.transitiveDependents && impact.transitiveDependents.length > 0) {
      html += `<div style="margin-top:10px;font-size:10px;color:#ff9f0a;font-weight:600;letter-spacing:2px">TRANSITIVE (${impact.transitiveDependents.length})</div>`;
      for (const t of impact.transitiveDependents) {
        const tn = graphData.nodes.find(n => n.id === t);
        const tc = tn ? LAYER_HEX[tn.layer]||"#999" : "#999";
        html += `<div class="impact-item transitive" data-file="${t}"><span style="color:${tc};margin-right:4px">[${tn?tn.layer:"?"}]</span>${t}</div>`;
      }
    }
    if (impact.totalImpacted === 0) html += '<p class="placeholder" style="margin-top:10px">SAFE TO MODIFY.</p>';
    document.getElementById("impact-content").innerHTML = html;
    document.querySelectorAll(".impact-item").forEach(el => {
      el.addEventListener("click", () => {
        const tn = graphData.nodes.find(n => n.id === el.dataset.file);
        if (tn && Graph) {
          const d = Math.max(1, Math.hypot(tn.x||1,tn.y||1,tn.z||1));
          Graph.cameraPosition(
            {x:(tn.x||0)+100*(tn.x||1)/d, y:(tn.y||0)+100*(tn.y||1)/d, z:(tn.z||0)+100*(tn.z||1)/d},
            {x:tn.x||0, y:tn.y||0, z:tn.z||0}, 800
          );
        }
      });
    });
  } catch(err) {
    document.getElementById("impact-content").innerHTML = `<p class="placeholder">ERROR: ${err.message}</p>`;
  }
}

function refreshGraph() {
  if (!Graph) return;
  Graph.nodeColor(Graph.nodeColor())
    .nodeVal(Graph.nodeVal())
    .nodeVisibility(Graph.nodeVisibility())
    .linkColor(Graph.linkColor()).linkWidth(Graph.linkWidth())
    .linkVisibility(Graph.linkVisibility())
    .linkDirectionalParticles(Graph.linkDirectionalParticles())
    .linkDirectionalParticleWidth(Graph.linkDirectionalParticleWidth())
    .linkDirectionalParticleColor(Graph.linkDirectionalParticleColor())
    .linkDirectionalArrowColor(Graph.linkDirectionalArrowColor());
}

// ═══════════════════════════════════════════
// AI ANALYSIS
// ═══════════════════════════════════════════
async function runAIAnalysis() {
  if (!selectedFile) return;
  const p = document.getElementById("ai-content");
  p.innerHTML = '<div class="loading"><div class="spinner"></div>GEMINI AI PROCESSING...</div>';
  try {
    const r = await fetch("/api/ai-analyze", {
      method: "POST", headers: {"Content-Type":"application/json"},
      body: JSON.stringify({ file: selectedFile }),
    });
    const j = await r.json();
    p.innerHTML = r.ok ? renderMD(j.analysis) : `<p class="placeholder">ERROR: ${j.error}</p>`;
  } catch(e) { p.innerHTML = `<p class="placeholder">ERROR: ${e.message}</p>`; }
}

function renderMD(t) {
  return t.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")
    .replace(/^## (.+)$/gm,"<h2>$1</h2>").replace(/^### (.+)$/gm,"<h3>$1</h3>")
    .replace(/\*\*(.+?)\*\*/g,"<strong>$1</strong>").replace(/`([^`]+)`/g,"<code>$1</code>")
    .replace(/^- (.+)$/gm,"<li>$1</li>").replace(/(<li>.*<\/li>)/gs,"<ul>$1</ul>")
    .replace(/\n\n/g,"<br><br>").replace(/\n/g,"<br>");
}

// ═══════════════════════════════════════════
// CODE PREVIEW
// ═══════════════════════════════════════════
async function loadCodePreview(fileId) {
  const el = document.getElementById("code-content");
  el.innerHTML = '<div class="loading"><div class="spinner"></div>LOADING...</div>';
  try {
    const res = await fetch("/api/file-content/" + fileId.split("/").map(encodeURIComponent).join("/"));
    const ct = res.headers.get("content-type") || "";
    if (!ct.includes("application/json")) {
      el.innerHTML = `<p class="placeholder">ERROR: Server returned non-JSON (${res.status}). File: ${fileId}</p>`;
      return;
    }
    const data = await res.json();
    if (!res.ok) { el.innerHTML = `<p class="placeholder">ERROR: ${data.error}</p>`; return; }

    const lines = data.content.split("\n");
    let html = '<div class="code-block">';
    lines.forEach((line, i) => {
      const escaped = line.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
      html += `<span class="line-num">${i+1}</span>${escaped}\n`;
    });
    html += '</div>';
    if (data.truncated) html += '<p class="placeholder" style="margin-top:8px">File truncated at 500 lines</p>';
    el.innerHTML = html;
  } catch(e) {
    el.innerHTML = `<p class="placeholder">ERROR: ${e.message}</p>`;
  }
}

// ═══════════════════════════════════════════
// DELETION SIMULATION
// ═══════════════════════════════════════════
async function loadSimulation(fileId) {
  const el = document.getElementById("sim-content");
  el.innerHTML = '<div class="loading"><div class="spinner"></div>SIMULATING...</div>';
  try {
    const res = await fetch("/api/simulate-delete/" + fileId.split("/").map(encodeURIComponent).join("/"));
    const ct = res.headers.get("content-type") || "";
    if (!ct.includes("application/json")) {
      el.innerHTML = `<p class="placeholder">ERROR: Server returned non-JSON (${res.status})</p>`;
      return;
    }
    const data = await res.json();
    if (!res.ok) { el.innerHTML = `<p class="placeholder">ERROR: ${data.error}</p>`; return; }

    let html = `<div class="file-detail"><span class="label">TARGET </span><span class="value">${data.deletedFile}</span></div>`;
    html += `<div class="sim-severity ${data.severity}">${data.severity} IMPACT</div>`;

    html += '<div class="sim-section"><h4>BROKEN IMPORTS (' + data.brokenCount + ')</h4>';
    if (data.brokenImports.length === 0) {
      html += '<p class="placeholder">No files import this directly</p>';
    } else {
      data.brokenImports.forEach(f => {
        html += `<div class="sim-file" data-file="${f}">${f}</div>`;
      });
    }
    html += '</div>';

    html += '<div class="sim-section"><h4>CASCADE AFFECTED (' + data.cascadeCount + ')</h4>';
    if (data.cascadeFiles.length === 0) {
      html += '<p class="placeholder">No cascade impact</p>';
    } else {
      data.cascadeFiles.slice(0, 30).forEach(f => {
        html += `<div class="sim-file" data-file="${f}">${f}</div>`;
      });
      if (data.cascadeFiles.length > 30) html += `<p class="placeholder">...and ${data.cascadeFiles.length - 30} more</p>`;
    }
    html += '</div>';

    if (data.orphanedCount > 0) {
      html += '<div class="sim-section"><h4>ORPHANED FILES (' + data.orphanedCount + ')</h4>';
      data.orphanedFiles.forEach(f => {
        html += `<div class="sim-file" data-file="${f}">${f}</div>`;
      });
      html += '</div>';
    }

    el.innerHTML = html;

    // Click to navigate
    el.querySelectorAll(".sim-file").forEach(sf => {
      sf.addEventListener("click", () => {
        const node = graphData.nodes.find(n => n.id === sf.dataset.file);
        if (node) handleNodeClick(node);
      });
    });
  } catch(e) {
    el.innerHTML = `<p class="placeholder">ERROR: ${e.message}</p>`;
  }
}

// ═══════════════════════════════════════════
// PATH MODE (shortest path between two nodes)
// ═══════════════════════════════════════════
function enterPathMode() {
  pathMode = true;
  pathFrom = null;
  pathTo = null;
  document.getElementById("btn-path-mode").classList.add("active");
  document.getElementById("path-indicator").classList.remove("hidden");
  document.getElementById("path-status").textContent = "SELECT FIRST NODE";
  document.getElementById("3d-graph").style.cursor = "crosshair";
}

function exitPathMode() {
  pathMode = false;
  pathFrom = null;
  pathTo = null;
  document.getElementById("btn-path-mode").classList.remove("active");
  document.getElementById("path-indicator").classList.add("hidden");
  document.getElementById("3d-graph").style.cursor = "grab";
  highlightNodes.clear();
  highlightLinks.clear();
  selectedNodeId = null;
  refreshGraph();
}

async function handlePathNodeClick(node) {
  if (!pathFrom) {
    pathFrom = node.id;
    selectedNodeId = node.id;
    highlightNodes.clear();
    highlightNodes.add(node.id);
    refreshGraph();
    document.getElementById("path-status").textContent = `FROM: ${node.label} → SELECT SECOND NODE`;
  } else if (!pathTo) {
    pathTo = node.id;
    document.getElementById("path-status").textContent = `TRACING PATH...`;
    await findShortestPath(pathFrom, pathTo);
  }
}

async function findShortestPath(from, to) {
  try {
    const res = await fetch(`/api/shortest-path?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
    const data = await res.json();

    if (data.distance < 0) {
      document.getElementById("path-status").textContent = "NO PATH FOUND";
      setTimeout(exitPathMode, 2000);
      return;
    }

    // Highlight path
    highlightNodes.clear();
    highlightLinks.clear();
    data.path.forEach(p => highlightNodes.add(p));

    // Highlight links along the path
    for (let i = 0; i < data.path.length - 1; i++) {
      graphData.links.forEach(l => {
        const src = getSrcId(l), tgt = getTgtId(l);
        if ((src === data.path[i] && tgt === data.path[i+1]) ||
            (src === data.path[i+1] && tgt === data.path[i])) {
          highlightLinks.add(l);
        }
      });
    }

    selectedNodeId = null;
    refreshGraph();
    document.getElementById("path-status").textContent = `PATH: ${data.distance} hops (${data.path.length} nodes)`;

    // Show path details in impact panel
    let html = `<div style="margin-bottom:10px;font-size:10px;color:#ffd700;font-weight:600;letter-spacing:2px">SHORTEST PATH (${data.distance} hops)</div>`;
    data.path.forEach((p, i) => {
      const n = graphData.nodes.find(x => x.id === p);
      const c = n ? LAYER_HEX[n.layer] || "#999" : "#999";
      const arrow = i < data.path.length - 1 ? ' <span style="color:#ffd700">→</span>' : '';
      html += `<div class="impact-item" data-file="${p}" style="color:${c}">[${n?n.layer:"?"}] ${p}${arrow}</div>`;
    });
    document.getElementById("impact-content").innerHTML = html;

    // Focus camera on midpoint
    const midIdx = Math.floor(data.path.length / 2);
    const midNode = graphData.nodes.find(n => n.id === data.path[midIdx]);
    if (midNode) {
      Graph.cameraPosition(
        { x: (midNode.x||0)+300, y: (midNode.y||0)+200, z: (midNode.z||0)+300 },
        { x: midNode.x||0, y: midNode.y||0, z: midNode.z||0 }, 1200
      );
    }

    // Auto-exit path mode after 10s
    setTimeout(() => {
      if (pathMode) exitPathMode();
    }, 15000);
  } catch(e) {
    document.getElementById("path-status").textContent = "ERROR: " + e.message;
    setTimeout(exitPathMode, 2000);
  }
}

// ═══════════════════════════════════════════
// CONTEXT MENU (right-click)
// ═══════════════════════════════════════════
function setupContextMenu() {
  document.addEventListener("click", () => hideContextMenu());
}

function showContextMenu(node, event) {
  if (!node) return;
  event.preventDefault();
  contextNode = node;
  const menu = document.getElementById("context-menu");
  menu.classList.remove("hidden");
  menu.style.left = event.clientX + "px";
  menu.style.top = event.clientY + "px";

  // Ensure menu doesn't go off-screen
  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) menu.style.left = (window.innerWidth - rect.width - 10) + "px";
  if (rect.bottom > window.innerHeight) menu.style.top = (window.innerHeight - rect.height - 10) + "px";
}

function hideContextMenu() {
  document.getElementById("context-menu").classList.add("hidden");
}

function handleContextAction(action) {
  if (!contextNode) return;
  hideContextMenu();

  switch(action) {
    case "focus":
      stopUser();
      Graph.cameraPosition(
        { x: (contextNode.x||0)+120, y: (contextNode.y||0)+80, z: (contextNode.z||0)+120 },
        { x: contextNode.x||0, y: contextNode.y||0, z: contextNode.z||0 }, 800
      );
      break;
    case "impact":
      handleNodeClick(contextNode);
      switchTab("info");
      break;
    case "ai":
      selectedFile = contextNode.id;
      selectedNodeId = contextNode.id;
      switchTab("info");
      runAIAnalysis();
      break;
    case "code":
      selectedFile = contextNode.id;
      selectedNodeId = contextNode.id;
      loadCodePreview(contextNode.id);
      switchTab("code");
      break;
    case "simulate":
      selectedFile = contextNode.id;
      selectedNodeId = contextNode.id;
      loadSimulation(contextNode.id);
      switchTab("simulate");
      break;
    case "path-from":
      enterPathMode();
      pathFrom = contextNode.id;
      selectedNodeId = contextNode.id;
      highlightNodes.clear();
      highlightNodes.add(contextNode.id);
      refreshGraph();
      document.getElementById("path-status").textContent = `FROM: ${contextNode.label} → SELECT SECOND NODE`;
      break;
    case "path-to":
      if (selectedFile && selectedFile !== contextNode.id) {
        enterPathMode();
        pathFrom = selectedFile;
        pathTo = contextNode.id;
        findShortestPath(pathFrom, pathTo);
      }
      break;
    case "isolate":
      // Show only nodes in same layer
      hiddenLayers.clear();
      LAYER_KEYS.forEach(l => { if (l !== contextNode.layer) hiddenLayers.add(l); });
      document.querySelectorAll(".legend-item").forEach(li => {
        li.classList.toggle("filtered", hiddenLayers.has(li.dataset.layer));
      });
      refreshGraph();
      break;
    case "hide":
      hiddenNodes.add(contextNode.id);
      if (selectedNodeId === contextNode.id) {
        selectedFile = null;
        selectedNodeId = null;
        highlightNodes.clear();
        highlightLinks.clear();
      }
      refreshGraph();
      break;
  }
}

// ═══════════════════════════════════════════
// TABS
// ═══════════════════════════════════════════
function setupTabs() {
  document.querySelectorAll(".panel-tab").forEach(tab => {
    tab.addEventListener("click", () => switchTab(tab.dataset.tab));
  });
}

function switchTab(tabName) {
  document.querySelectorAll(".panel-tab").forEach(t => t.classList.toggle("active", t.dataset.tab === tabName));
  document.querySelectorAll(".tab-content").forEach(c => c.classList.toggle("active", c.id === "tab-" + tabName));
}

// ═══════════════════════════════════════════
// STATS CHARTS
// ═══════════════════════════════════════════
function showStats() {
  document.getElementById("stats-overlay").classList.remove("hidden");
  renderLayerChart();
  renderRiskChart();
  renderLinesChart();
  renderDepsChart();
  renderStatsSummary();
}

function renderLayerChart() {
  const canvas = document.getElementById("chart-layers");
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const counts = {};
  graphData.nodes.forEach(n => { counts[n.layer] = (counts[n.layer] || 0) + 1; });

  const entries = Object.entries(counts).sort((a,b) => b[1] - a[1]);
  const maxVal = Math.max(...entries.map(e => e[1]));
  const barH = 22;
  const gap = 6;
  const labelW = 55;
  const barMaxW = canvas.width - labelW - 40;

  entries.forEach(([layer, count], i) => {
    const y = i * (barH + gap) + 10;
    const w = (count / maxVal) * barMaxW;
    const color = LAYER_HEX[layer] || "#999";

    ctx.fillStyle = color;
    ctx.globalAlpha = 0.3;
    ctx.fillRect(labelW, y, w, barH);
    ctx.globalAlpha = 1;
    ctx.fillStyle = color;
    ctx.fillRect(labelW, y, 3, barH);

    ctx.fillStyle = color;
    ctx.font = "bold 10px Consolas";
    ctx.textAlign = "right";
    ctx.fillText(layer, labelW - 8, y + 15);

    ctx.fillStyle = "#c8d6e5";
    ctx.textAlign = "left";
    ctx.fillText(count.toString(), labelW + w + 6, y + 15);
  });
}

function renderRiskChart() {
  const canvas = document.getElementById("chart-risk");
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const counts = { HIGH: 0, MEDIUM: 0, LOW: 0, NONE: 0 };
  graphData.nodes.forEach(n => { counts[n.riskLevel] = (counts[n.riskLevel] || 0) + 1; });

  const colors = { HIGH: "#ff2d55", MEDIUM: "#ff9f0a", LOW: "#30d158", NONE: "#3a4f6f" };
  const total = graphData.nodes.length;
  const cx = 90, cy = 90, r = 70;
  let startAngle = -Math.PI / 2;

  Object.entries(counts).forEach(([level, count]) => {
    if (count === 0) return;
    const sliceAngle = (count / total) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, r, startAngle, startAngle + sliceAngle);
    ctx.closePath();
    ctx.fillStyle = colors[level];
    ctx.globalAlpha = 0.6;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = "#050a18";
    ctx.lineWidth = 2;
    ctx.stroke();

    // Label
    const midAngle = startAngle + sliceAngle / 2;
    const lx = cx + (r + 20) * Math.cos(midAngle);
    const ly = cy + (r + 20) * Math.sin(midAngle);
    ctx.fillStyle = colors[level];
    ctx.font = "bold 9px Consolas";
    ctx.textAlign = "center";
    ctx.fillText(`${level}:${count}`, lx, ly);

    startAngle += sliceAngle;
  });
}

function renderLinesChart() {
  const canvas = document.getElementById("chart-lines");
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const sorted = [...graphData.nodes].sort((a,b) => b.lineCount - a.lineCount).slice(0, 10);
  const maxVal = sorted[0]?.lineCount || 1;
  const barH = 14;
  const gap = 4;
  const barMaxW = canvas.width - 50;

  sorted.forEach((n, i) => {
    const y = i * (barH + gap) + 4;
    const w = (n.lineCount / maxVal) * barMaxW;
    const color = LAYER_HEX[n.layer] || "#999";

    ctx.fillStyle = color;
    ctx.globalAlpha = 0.25;
    ctx.fillRect(0, y, w, barH);
    ctx.globalAlpha = 1;

    ctx.fillStyle = "#c8d6e5";
    ctx.font = "9px Consolas";
    ctx.textAlign = "left";
    const name = n.label.length > 25 ? n.label.slice(0, 22) + "..." : n.label;
    ctx.fillText(name, 4, y + 11);

    ctx.fillStyle = color;
    ctx.textAlign = "left";
    ctx.fillText(n.lineCount.toString(), w + 4, y + 11);
  });
}

function renderDepsChart() {
  const canvas = document.getElementById("chart-deps");
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const sorted = [...graphData.nodes].sort((a,b) => b.dependentCount - a.dependentCount).slice(0, 10);
  const maxVal = sorted[0]?.dependentCount || 1;
  const barH = 14;
  const gap = 4;
  const barMaxW = canvas.width - 50;

  sorted.forEach((n, i) => {
    const y = i * (barH + gap) + 4;
    const w = (n.dependentCount / maxVal) * barMaxW;
    const color = n.riskLevel === "HIGH" ? "#ff2d55" : n.riskLevel === "MEDIUM" ? "#ff9f0a" : "#30d158";

    ctx.fillStyle = color;
    ctx.globalAlpha = 0.25;
    ctx.fillRect(0, y, w, barH);
    ctx.globalAlpha = 1;

    ctx.fillStyle = "#c8d6e5";
    ctx.font = "9px Consolas";
    ctx.textAlign = "left";
    const name = n.label.length > 25 ? n.label.slice(0, 22) + "..." : n.label;
    ctx.fillText(name, 4, y + 11);

    ctx.fillStyle = color;
    ctx.textAlign = "left";
    ctx.fillText(n.dependentCount.toString(), w + 4, y + 11);
  });
}

function renderStatsSummary() {
  const totalLines = graphData.nodes.reduce((s, n) => s + n.lineCount, 0);
  const avgLines = Math.round(totalLines / graphData.nodes.length);
  const maxDeps = Math.max(...graphData.nodes.map(n => n.dependentCount));
  const avgDeps = (graphData.nodes.reduce((s, n) => s + n.dependentCount, 0) / graphData.nodes.length).toFixed(1);
  const maxDepth = Math.max(...graphData.nodes.map(n => n.depth));
  const isolated = graphData.nodes.filter(n => n.dependentCount === 0 && n.importsCount === 0).length;

  document.getElementById("stats-summary").innerHTML = `
    <strong style="color:#00d4ff">TOTAL LINES:</strong> ${totalLines.toLocaleString()} &middot;
    <strong style="color:#00d4ff">AVG:</strong> ${avgLines} lines/file &middot;
    <strong style="color:#00d4ff">MAX DEPS:</strong> ${maxDeps} &middot;
    <strong style="color:#00d4ff">AVG DEPS:</strong> ${avgDeps} &middot;
    <strong style="color:#00d4ff">MAX DEPTH:</strong> ${maxDepth} &middot;
    <strong style="color:#00d4ff">ISOLATED:</strong> ${isolated} files
  `;
}

// ═══════════════════════════════════════════
// CYCLES DETECTION
// ═══════════════════════════════════════════
async function detectCycles() {
  document.getElementById("cycles-overlay").classList.remove("hidden");
  document.getElementById("cycles-content").innerHTML = '<div class="loading"><div class="spinner"></div>SCANNING...</div>';

  try {
    const res = await fetch("/api/cycles");
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      document.getElementById("cycles-content").innerHTML = `<div class="no-cycles" style="color:#667">${err.error || "Cycle detection requires Pro."} <a href="${err.upgrade || 'https://syke.cloud/dashboard/'}" target="_blank" style="color:#00d4ff">Upgrade</a></div>`;
      return;
    }
    const data = await res.json();

    if (data.count === 0) {
      document.getElementById("cycles-content").innerHTML = '<div class="no-cycles">NO CIRCULAR DEPENDENCIES DETECTED</div>';
      return;
    }

    let html = `<p style="margin-bottom:12px;font-size:11px;color:#ff2d55">${data.count} cycle(s) detected:</p>`;
    data.cycles.forEach((cycle, i) => {
      html += `<div class="cycle-item"><h4>CYCLE ${i+1}</h4><div class="cycle-path">`;
      cycle.forEach((file, j) => {
        if (j > 0) html += '<span class="arrow">→</span>';
        html += `<span class="file" data-file="${file}">${file}</span>`;
      });
      html += '</div></div>';
    });

    document.getElementById("cycles-content").innerHTML = html;

    // Highlight all cycle nodes
    highlightNodes.clear();
    highlightLinks.clear();
    data.cycles.forEach(cycle => {
      cycle.forEach(f => highlightNodes.add(f));
    });
    refreshGraph();

    // Click to navigate
    document.querySelectorAll("#cycles-content .file").forEach(el => {
      el.addEventListener("click", () => {
        const node = graphData.nodes.find(n => n.id === el.dataset.file);
        if (node) {
          stopUser();
          Graph.cameraPosition(
            { x: (node.x||0)+120, y: (node.y||0)+80, z: (node.z||0)+120 },
            { x: node.x||0, y: node.y||0, z: node.z||0 }, 800
          );
        }
      });
    });
  } catch(e) {
    document.getElementById("cycles-content").innerHTML = `<p class="placeholder">ERROR: ${e.message}</p>`;
  }
}

// ═══════════════════════════════════════════
// KEYBOARD SHORTCUTS
// ═══════════════════════════════════════════
function setupKeyboardShortcuts() {
  document.addEventListener("keydown", e => {
    // Don't trigger if typing in search
    if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;

    switch(e.key.toLowerCase()) {
      case "r":
        resetView();
        break;
      case "a":
        toggleAutoRotate();
        break;
      case "p":
        if (pathMode) exitPathMode();
        else enterPathMode();
        break;
      case "f":
        if (selectedNodeId) {
          const node = graphData.nodes.find(n => n.id === selectedNodeId);
          if (node) {
            stopUser();
            Graph.cameraPosition(
              { x: (node.x||0)+120, y: (node.y||0)+80, z: (node.z||0)+120 },
              { x: node.x||0, y: node.y||0, z: node.z||0 }, 800
            );
          }
        }
        break;
      case "c":
        if (selectedFile) { loadCodePreview(selectedFile); switchTab("code"); }
        break;
      case "s":
        if (selectedFile) { loadSimulation(selectedFile); switchTab("simulate"); }
        break;
      case "t":
        toggleFileTreePanel();
        break;
      case "d":
        detectCycles();
        break;
      case "escape":
        if (pathMode) { exitPathMode(); return; }
        if (!document.getElementById("stats-overlay").classList.contains("hidden")) {
          document.getElementById("stats-overlay").classList.add("hidden"); return;
        }
        if (!document.getElementById("shortcuts-overlay").classList.contains("hidden")) {
          document.getElementById("shortcuts-overlay").classList.add("hidden"); return;
        }
        if (!document.getElementById("cycles-overlay").classList.contains("hidden")) {
          document.getElementById("cycles-overlay").classList.add("hidden");
          highlightNodes.clear(); highlightLinks.clear();
          refreshGraph();
          return;
        }
        handleBackgroundClick();
        break;
      case "/": case "?":
        e.preventDefault();
        document.getElementById("shortcuts-overlay").classList.toggle("hidden");
        break;
      case "1": toggleLayerByIndex(0); break;
      case "2": toggleLayerByIndex(1); break;
      case "3": toggleLayerByIndex(2); break;
      case "4": toggleLayerByIndex(3); break;
      case "5": toggleLayerByIndex(4); break;
      case "6": toggleLayerByIndex(5); break;
    }
  });
}

function toggleLayerByIndex(idx) {
  const layer = LAYER_KEYS[idx];
  if (!layer) return;
  if (hiddenLayers.has(layer)) hiddenLayers.delete(layer);
  else hiddenLayers.add(layer);
  document.querySelectorAll(".legend-item").forEach(li => {
    li.classList.toggle("filtered", hiddenLayers.has(li.dataset.layer));
  });
  refreshGraph();
}

function resetView() {
  selectedFile = null; selectedNodeId = null;
  highlightNodes.clear(); highlightLinks.clear();
  hiddenLayers.clear(); hiddenNodes.clear();
  document.querySelectorAll(".legend-item").forEach(li => li.classList.remove("filtered"));
  document.getElementById("file-info-content").innerHTML = '<p class="placeholder">Select a node to identify target</p>';
  document.getElementById("impact-content").innerHTML = '<p class="placeholder">Select a node to trace impact chain</p>';
  document.getElementById("ai-content").innerHTML = '<p class="placeholder">Select target, then request AI analysis</p>';
  document.getElementById("code-content").innerHTML = '<p class="placeholder">Select a node to preview source code</p>';
  document.getElementById("sim-content").innerHTML = '<p class="placeholder">Select a node, then switch to SIM tab</p>';
  document.getElementById("btn-ai-analyze").disabled = true;
  if (pathMode) exitPathMode();
  stopCodeCrawl();
  refreshGraph();
  Graph.cameraPosition({ x:0,y:0,z:SETTINGS.camera.resetDistance }, { x:0,y:0,z:0 }, 1000);
}

function toggleAutoRotate() {
  autoRotate = !autoRotate;
  document.getElementById("btn-auto-rotate").classList.toggle("active", autoRotate);
  if (autoRotate) startAutoRotate(); else stopAutoRotate();
}

// ═══════════════════════════════════════════
// HUB FILES
// ═══════════════════════════════════════════
async function loadHubFiles() {
  try {
    const r = await fetch("/api/hub-files?top=15");
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      const c = document.getElementById("hub-content");
      if (c) c.innerHTML = `<div class="placeholder" style="padding:12px;font-size:11px;color:var(--text-muted,#667)">${err.error || "Hub files require Pro."} <a href="${err.upgrade || 'https://syke.cloud/dashboard/'}" target="_blank" style="color:#00d4ff">Upgrade</a></div>`;
      return;
    }
    const d = await r.json();
    const c = document.getElementById("hub-content"); let h = "";
    d.hubs.forEach((hub,i) => {
      h += `<div class="hub-item" data-file="${hub.relativePath}">
        <span class="hub-rank">${i+1}.</span><span class="hub-name">${hub.relativePath}</span>
        <span class="hub-count">${hub.dependentCount}</span><span class="risk-badge ${hub.riskLevel}">${hub.riskLevel}</span></div>`;
    });
    c.innerHTML = h;
    c.querySelectorAll(".hub-item").forEach(el => {
      el.addEventListener("click", () => { const n = graphData.nodes.find(n => n.id === el.dataset.file); if (n) handleNodeClick(n); });
    });
  } catch(e) { console.error("Hub:", e); }
}

// ═══════════════════════════════════════════
// EVENT LISTENERS
// ═══════════════════════════════════════════
function setupEventListeners() {
  document.getElementById("btn-ai-analyze").addEventListener("click", runAIAnalysis);

  document.getElementById("btn-reset").addEventListener("click", resetView);

  document.getElementById("btn-auto-rotate").addEventListener("click", toggleAutoRotate);

  document.getElementById("btn-path-mode").addEventListener("click", () => {
    if (pathMode) exitPathMode();
    else enterPathMode();
  });

  document.getElementById("btn-cancel-path").addEventListener("click", exitPathMode);

  document.getElementById("search-input").addEventListener("input", e => {
    const q = e.target.value.toLowerCase().trim();
    highlightNodes.clear(); highlightLinks.clear(); selectedNodeId = null;

    if (!q) {
      // ── Clear search: restore full view ──
      searchActive = false;
      if (_searchRAF) { cancelAnimationFrame(_searchRAF); _searchRAF = null; }
      refreshGraph();
      // Smooth zoom-out to overview
      if (Graph) {
        Graph.cameraPosition(
          { x: 0, y: 0, z: SETTINGS.camera.resetDistance },
          { x: 0, y: 0, z: 0 }, 800
        );
      }
      return;
    }

    // ── Active search: find matching nodes ──
    searchActive = true;
    graphData.nodes.forEach(n => {
      if (n.fullPath.toLowerCase().includes(q) || n.layer.toLowerCase() === q || n.label.toLowerCase().includes(q)) {
        highlightNodes.add(n.id);
      }
    });

    // Also highlight links between matched nodes
    if (highlightNodes.size > 0) {
      graphData.links.forEach(l => {
        const sid = getSrcId(l), tid = getTgtId(l);
        if (highlightNodes.has(sid) || highlightNodes.has(tid)) highlightLinks.add(l);
      });

      // Camera: frame all matched nodes (centroid)
      let cx = 0, cy = 0, cz = 0, cnt = 0;
      graphData.nodes.forEach(n => {
        if (highlightNodes.has(n.id) && n.x != null) {
          cx += n.x; cy += (n.y || 0); cz += (n.z || 0); cnt++;
        }
      });
      if (cnt > 0) {
        cx /= cnt; cy /= cnt; cz /= cnt;
        stopUser();
        const dist = cnt === 1 ? 600 : Math.min(2500, 800 + cnt * 80);
        Graph.cameraPosition(
          { x: cx + dist * 0.3, y: cy + dist * 0.2, z: cz + dist },
          { x: cx, y: cy, z: cz }, 600
        );
      }
    }

    refreshGraph();
    // Start glow animation loop for search matches
    if (!_searchRAF && highlightNodes.size > 0) {
      function searchGlow() {
        if (!searchActive) { _searchRAF = null; return; }
        if (Graph) Graph.nodeColor(Graph.nodeColor());
        _searchRAF = requestAnimationFrame(searchGlow);
      }
      _searchRAF = requestAnimationFrame(searchGlow);
    }
  });

  document.getElementById("btn-toggle-hub").addEventListener("click", () => {
    document.getElementById("hub-drawer").classList.toggle("collapsed");
  });

  // Stats
  document.getElementById("btn-stats").addEventListener("click", showStats);
  document.getElementById("btn-close-stats").addEventListener("click", () => {
    document.getElementById("stats-overlay").classList.add("hidden");
  });

  // Shortcuts
  document.getElementById("btn-shortcuts").addEventListener("click", () => {
    document.getElementById("shortcuts-overlay").classList.toggle("hidden");
  });
  document.getElementById("btn-close-shortcuts").addEventListener("click", () => {
    document.getElementById("shortcuts-overlay").classList.add("hidden");
  });

  // Cycles
  document.getElementById("btn-cycles").addEventListener("click", detectCycles);
  document.getElementById("btn-close-cycles").addEventListener("click", () => {
    document.getElementById("cycles-overlay").classList.add("hidden");
    highlightNodes.clear(); highlightLinks.clear();
    refreshGraph();
  });

  // Context menu actions
  document.querySelectorAll(".ctx-item").forEach(item => {
    item.addEventListener("click", (e) => {
      e.stopPropagation();
      handleContextAction(item.dataset.action);
    });
  });

  // Close overlays on background click
  ["stats-overlay", "shortcuts-overlay", "cycles-overlay"].forEach(id => {
    document.getElementById(id).addEventListener("click", (e) => {
      if (e.target.id === id) document.getElementById(id).classList.add("hidden");
    });
  });

  // ── Resizable Panels ──
  setupResizeHandle();
  setupTreeResizeHandle();
}

// ═══════════════════════════════════════════
// DART SYNTAX HIGHLIGHTING (VS Code Dark+)
// ═══════════════════════════════════════════
function highlightDart(line) {
  // Escape HTML first
  let s = line.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  // Full-line comment
  if (/^\s*\/\//.test(s)) {
    return `<span class="cmt">${s}</span>`;
  }

  // Tokenize with regex replacements (order matters)
  // Strings (single and double quoted)
  s = s.replace(/(&#39;[^&#39;]*&#39;|&quot;[^&quot;]*&quot;|'[^']*'|"[^"]*")/g, '<span class="str">$1</span>');

  // Annotations (@override, @required, etc)
  s = s.replace(/(@\w+)/g, '<span class="ann">$1</span>');

  // Numbers
  s = s.replace(/\b(\d+\.?\d*)\b/g, '<span class="num">$1</span>');

  // Dart keywords
  s = s.replace(/\b(import|export|library|part|show|hide|as|if|else|for|while|do|switch|case|break|continue|return|yield|async|await|try|catch|finally|throw|rethrow|new|const|final|var|late|required|static|abstract|class|extends|implements|with|mixin|enum|typedef|void|dynamic|super|this|is|in|true|false|null|factory|get|set|operator|external|covariant)\b/g, '<span class="kw">$1</span>');

  // Dart types (capitalized words that look like types)
  s = s.replace(/\b(String|int|double|bool|num|List|Map|Set|Future|Stream|Widget|BuildContext|State|Key|Color|Text|Container|Column|Row|Scaffold|Navigator|Provider|Ref|Notifier|Override|Object|Function|Type|Iterable|Duration|DateTime|File|Directory|Uri)\b/g, '<span class="type">$1</span>');

  // Function calls: word followed by (
  s = s.replace(/\b([a-z_]\w*)\s*(?=\()/g, '<span class="fn">$1</span>');

  // Punctuation
  s = s.replace(/([{}()\[\];,])/g, '<span class="punc">$1</span>');

  return s;
}

// ═══════════════════════════════════════════
// CODE CRAWL (auto-scroll + manual scrollbar)
// ═══════════════════════════════════════════
let crawlAutoScroll = true;
let crawlUserTimer = null;

async function startCodeCrawl(fileId) {
  stopCodeCrawl();

  const crawlEl = document.getElementById("code-crawl");
  const contentEl = document.getElementById("crawl-content");
  const viewport = document.getElementById("crawl-viewport");
  const headerName = document.getElementById("crawl-file-name");
  const headerStatus = document.getElementById("crawl-status");

  headerName.textContent = fileId;
  headerStatus.textContent = "LOADING";
  headerStatus.className = "";
  contentEl.innerHTML = "";
  crawlEl.classList.add("active");
  crawlAutoScroll = true;

  try {
    const res = await fetch("/api/connected-code", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file: fileId, maxFiles: 5, maxLinesPerFile: 40 }),
    });
    const data = await res.json();
    if (!res.ok) { headerStatus.textContent = "ERROR"; return; }

    crawlData = data.files;
    headerStatus.textContent = `${data.files.length} FILES`;

    // Build HTML with syntax highlighting
    let html = "";
    data.files.forEach((file) => {
      const col = LAYER_HEX[file.layer] || "#00d4ff";
      html += `<div class="crawl-separator">`;
      html += `<span class="sep-path" style="color:${col}">${file.path}</span>`;
      html += `<span class="sep-layer" style="color:${col}">[${file.layer}] ${file.lineCount}L</span>`;
      html += `</div>`;
      file.lines.forEach((line, li) => {
        html += `<div class="crawl-line" data-file="${file.path}" data-line="${li+1}">`;
        html += `<span class="cl-num">${li+1}</span>${highlightDart(line)}`;
        html += `</div>`;
      });
    });
    contentEl.innerHTML = html;

    // User scrolls → pause auto, resume after 3s idle
    viewport.addEventListener("wheel", pauseAutoScroll, { passive: true });
    viewport.addEventListener("mousedown", pauseAutoScroll);
    viewport.addEventListener("touchstart", pauseAutoScroll);

    // Start auto-scroll
    viewport.scrollTop = 0;
    crawlAnimationId = requestAnimationFrame(crawlLoop);
  } catch(e) {
    headerStatus.textContent = "ERROR";
  }
}

function crawlLoop() {
  if (!crawlAutoScroll) { crawlAnimationId = requestAnimationFrame(crawlLoop); return; }
  const vp = document.getElementById("crawl-viewport");
  if (!vp) return;
  vp.scrollTop += 0.5;
  // Loop back to top when reached bottom
  if (vp.scrollTop >= vp.scrollHeight - vp.clientHeight) {
    vp.scrollTop = 0;
  }
  crawlAnimationId = requestAnimationFrame(crawlLoop);
}

function pauseAutoScroll() {
  crawlAutoScroll = false;
  if (crawlUserTimer) clearTimeout(crawlUserTimer);
  crawlUserTimer = setTimeout(() => { crawlAutoScroll = true; }, 3000);
}

function stopCodeCrawl() {
  if (crawlAnimationId) { cancelAnimationFrame(crawlAnimationId); crawlAnimationId = null; }
  if (crawlUserTimer) { clearTimeout(crawlUserTimer); crawlUserTimer = null; }
  const vp = document.getElementById("crawl-viewport");
  if (vp) { vp.removeEventListener("wheel", pauseAutoScroll); vp.removeEventListener("mousedown", pauseAutoScroll); vp.removeEventListener("touchstart", pauseAutoScroll); }
  // Code crawl stays always visible — never hide
  crawlData = null;
}

// ═══════════════════════════════════════════
// CODE CRAWL: DRAG SUPPORT
// ═══════════════════════════════════════════
(function initCrawlDrag() {
  let isDragging = false, startX, startY, startLeft, startTop;
  document.addEventListener("DOMContentLoaded", () => {
    const crawlEl = document.getElementById("code-crawl");
    const header = document.getElementById("crawl-header");
    if (!crawlEl || !header) return;

    header.addEventListener("mousedown", (e) => {
      if (e.target.closest("#crawl-viewport")) return;
      isDragging = true;
      crawlEl.classList.add("dragging");
      const rect = crawlEl.getBoundingClientRect();
      const parent = crawlEl.offsetParent.getBoundingClientRect();
      startX = e.clientX;
      startY = e.clientY;
      startLeft = rect.left - parent.left;
      startTop = rect.top - parent.top;
      crawlEl.style.left = startLeft + "px";
      crawlEl.style.top = startTop + "px";
      crawlEl.style.bottom = "auto";
      e.preventDefault();
    });

    document.addEventListener("mousemove", (e) => {
      if (!isDragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      crawlEl.style.left = (startLeft + dx) + "px";
      crawlEl.style.top = (startTop + dy) + "px";
    });

    document.addEventListener("mouseup", () => {
      if (!isDragging) return;
      isDragging = false;
      crawlEl.classList.remove("dragging");
    });
  });
})();

// ═══════════════════════════════════════════
// REAL-TIME DIFF VIEWER (SSE-driven)
// ═══════════════════════════════════════════
function showRealtimeDiff(data) {
  const crawlEl = document.getElementById("code-crawl");
  const contentEl = document.getElementById("crawl-content");
  const viewport = document.getElementById("crawl-viewport");
  const headerName = document.getElementById("crawl-file-name");
  const headerStatus = document.getElementById("crawl-status");

  // Stop any existing crawl animation
  if (crawlAnimationId) { cancelAnimationFrame(crawlAnimationId); crawlAnimationId = null; }

  // Set header
  const fileName = data.file.split("/").pop();
  headerName.textContent = data.file;
  headerStatus.textContent = data.type.toUpperCase();
  headerStatus.className = "modifying";
  crawlEl.classList.add("active");

  // Build a set of changed line numbers for highlighting
  const changedLines = new Map(); // lineNum → {type, old, new}
  if (data.diff) {
    data.diff.forEach(d => {
      changedLines.set(d.line, d);
    });
  }

  let html = "";

  if (data.type === "deleted") {
    // File was deleted — show old content as all red
    html += `<div class="diff-banner diff-deleted">FILE DELETED</div>`;
  } else if (data.type === "added") {
    // New file — show all lines as green
    html += `<div class="diff-banner diff-added">NEW FILE</div>`;
    if (data.newContent) {
      data.newContent.forEach((line, i) => {
        const lineNum = i + 1;
        html += `<div class="crawl-line added" data-file="${data.file}" data-line="${lineNum}">`;
        html += `<span class="cl-num">${lineNum}</span>`;
        html += `<span class="diff-marker">+</span>`;
        html += highlightDart(line);
        html += `</div>`;
      });
    }
  } else {
    // Modified — show full file with diff highlights
    html += `<div class="diff-banner diff-modified">${data.diffCount} LINES CHANGED</div>`;

    if (data.newContent) {
      data.newContent.forEach((line, i) => {
        const lineNum = i + 1;
        const change = changedLines.get(lineNum);
        let cls = "";
        let marker = " ";

        if (change) {
          if (change.type === "added") {
            cls = "added";
            marker = "+";
          } else if (change.type === "removed") {
            cls = "removed";
            marker = "-";
          } else if (change.type === "changed") {
            cls = "changed";
            marker = "~";
          }
        }

        // If this line was changed, also show the old line above it (strikethrough red)
        if (change && change.type === "changed" && change.old !== undefined) {
          html += `<div class="crawl-line removed" data-file="${data.file}" data-line="${lineNum}">`;
          html += `<span class="cl-num">${lineNum}</span>`;
          html += `<span class="diff-marker">-</span>`;
          html += `<span class="old-code">${highlightDart(change.old)}</span>`;
          html += `</div>`;
        }

        html += `<div class="crawl-line ${cls}" data-file="${data.file}" data-line="${lineNum}">`;
        html += `<span class="cl-num">${lineNum}</span>`;
        if (marker !== " ") html += `<span class="diff-marker">${marker}</span>`;
        html += highlightDart(line);
        html += `</div>`;
      });
    }

    // Show removed lines that are beyond the new content length
    data.diff?.forEach(d => {
      if (d.type === "removed" && d.line > (data.newContent?.length || 0)) {
        html += `<div class="crawl-line removed" data-file="${data.file}" data-line="${d.line}">`;
        html += `<span class="cl-num">${d.line}</span>`;
        html += `<span class="diff-marker">-</span>`;
        html += `<span class="old-code">${highlightDart(d.old || "")}</span>`;
        html += `</div>`;
      }
    });
  }

  contentEl.innerHTML = html;

  // ── Mirror diff to CODE tab (VS Code style) ──
  renderCodeTabDiff(data, html);

  // ── Animated diff scroll: sweep through file, pause on changes ──
  if (diffScrollAnim) cancelAnimationFrame(diffScrollAnim);
  viewport.scrollTop = 0;

  const changedEls = contentEl.querySelectorAll(".crawl-line.added, .crawl-line.changed, .crawl-line.removed");
  if (changedEls.length > 0) {
    let currentIdx = 0;
    let pauseUntil = 0;
    let userPaused = false;

    function diffScrollLoop() {
      if (userPaused) { diffScrollAnim = requestAnimationFrame(diffScrollLoop); return; }
      const now = Date.now();
      if (now < pauseUntil) { diffScrollAnim = requestAnimationFrame(diffScrollLoop); return; }

      if (currentIdx < changedEls.length) {
        const el = changedEls[currentIdx];
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        // Flash effect on the line
        el.classList.add("diff-flash-active");
        setTimeout(() => el.classList.remove("diff-flash-active"), 800);
        currentIdx++;
        pauseUntil = now + 1500; // pause 1.5s on each change
      } else {
        // Loop: go back to first change after a longer pause
        currentIdx = 0;
        pauseUntil = now + 3000;
      }
      diffScrollAnim = requestAnimationFrame(diffScrollLoop);
    }

    // Start after brief initial delay
    setTimeout(() => { diffScrollAnim = requestAnimationFrame(diffScrollLoop); }, 500);

    // User scroll pauses the auto-animation
    const pauseHandler = () => {
      userPaused = true;
      if (crawlUserTimer) clearTimeout(crawlUserTimer);
      crawlUserTimer = setTimeout(() => { userPaused = false; }, 4000);
    };
    viewport.addEventListener("wheel", pauseHandler, { passive: true });
    viewport.addEventListener("mousedown", pauseHandler);
  } else {
    viewport.scrollTop = 0;
  }
}

function updateDiffWithAnalysis(analysis) {
  const headerStatus = document.getElementById("crawl-status");
  if (!headerStatus) return;

  const riskColors = {
    CRITICAL: "#ff0040",
    HIGH: "#ff2d55",
    MEDIUM: "#ff9f0a",
    LOW: "#30d158",
    SAFE: "#30d158",
  };
  const color = riskColors[analysis.riskLevel] || "#c8d6e5";
  headerStatus.textContent = `${analysis.riskLevel} — ${analysis.summary || "분석 완료"}`;
  headerStatus.style.color = color;
  headerStatus.className = "";

  // Add analysis summary at top of diff
  const contentEl = document.getElementById("crawl-content");
  if (contentEl && analysis.summary) {
    const banner = document.createElement("div");
    banner.className = `diff-banner diff-analysis`;
    banner.style.borderColor = color;
    banner.style.color = color;
    let text = `AI: ${analysis.summary}`;
    if (analysis.suggestion) text += ` | ${analysis.suggestion}`;
    banner.textContent = text;

    // Insert after the first banner
    const firstBanner = contentEl.querySelector(".diff-banner");
    if (firstBanner && firstBanner.nextSibling) {
      contentEl.insertBefore(banner, firstBanner.nextSibling);
    } else {
      contentEl.prepend(banner);
    }
  }
}

// ═══════════════════════════════════════════
// CODE TAB: VS Code-style real-time diff viewer
// ═══════════════════════════════════════════
let codeTabScrollAnim = null;

function renderCodeTabDiff(data, diffHtml) {
  const codeEl = document.getElementById("code-content");
  if (!codeEl) return;

  // Build VS Code-style header
  const fileName = data.file.split("/").pop();
  const ext = fileName.split(".").pop();
  const langLabel = { ts: "TypeScript", tsx: "TypeScript React", js: "JavaScript", jsx: "JSX",
    dart: "Dart", py: "Python", go: "Go", rs: "Rust", java: "Java", cpp: "C++", rb: "Ruby",
    css: "CSS", html: "HTML", json: "JSON", md: "Markdown", yaml: "YAML", yml: "YAML" }[ext] || ext.toUpperCase();
  const changeIcon = data.type === "added" ? "A" : data.type === "deleted" ? "D" : "M";
  const changeCls = data.type === "added" ? "vsc-added" : data.type === "deleted" ? "vsc-deleted" : "vsc-modified";

  let html = `<div class="vsc-editor">`;
  // Tab bar (like VS Code file tab)
  html += `<div class="vsc-tab-bar">`;
  html += `<div class="vsc-tab active">`;
  html += `<span class="vsc-tab-change ${changeCls}">${changeIcon}</span>`;
  html += `<span class="vsc-tab-name">${fileName}</span>`;
  html += `<span class="vsc-tab-lang">${langLabel}</span>`;
  html += `</div>`;
  html += `</div>`;
  // Breadcrumb path
  html += `<div class="vsc-breadcrumb">${data.file}</div>`;
  // Diff content area (reuse crawl-line classes)
  html += `<div class="vsc-diff-body">${diffHtml}</div>`;
  // Status bar
  const lineCount = data.newContent ? data.newContent.length : 0;
  const diffCount = data.diffCount || 0;
  html += `<div class="vsc-status-bar">`;
  html += `<span class="vsc-status-item">${langLabel}</span>`;
  html += `<span class="vsc-status-item">Ln ${lineCount}</span>`;
  html += `<span class="vsc-status-item vsc-status-diff">+${diffCount} changes</span>`;
  html += `<span class="vsc-status-item">${new Date().toLocaleTimeString()}</span>`;
  html += `</div>`;
  html += `</div>`;

  codeEl.innerHTML = html;

  // Auto-switch to CODE tab
  switchTab("code");

  // Auto-scroll to first change
  if (codeTabScrollAnim) cancelAnimationFrame(codeTabScrollAnim);
  setTimeout(() => {
    const diffBody = codeEl.querySelector(".vsc-diff-body");
    const firstChange = diffBody?.querySelector(".crawl-line.added, .crawl-line.changed, .crawl-line.removed");
    if (firstChange && diffBody) {
      firstChange.scrollIntoView({ behavior: "smooth", block: "center" });
      firstChange.classList.add("diff-flash-active");
      setTimeout(() => firstChange.classList.remove("diff-flash-active"), 1200);
    }
  }, 300);
}

function updateCodeTabAnalysis(analysis) {
  const statusBar = document.querySelector(".vsc-status-bar");
  if (!statusBar) return;

  const riskColors = { CRITICAL: "#f85149", HIGH: "#ff6b6b", MEDIUM: "#e3b341", LOW: "#3fb950", SAFE: "#3fb950" };
  const color = riskColors[analysis.riskLevel] || "#888";
  statusBar.style.background = analysis.riskLevel === "CRITICAL" || analysis.riskLevel === "HIGH" ? "#6e1b1b" : "#007acc";

  // Add risk badge to status bar
  const existing = statusBar.querySelector(".vsc-risk-badge");
  if (existing) existing.remove();
  const badge = document.createElement("span");
  badge.className = "vsc-risk-badge";
  badge.style.cssText = `background:${color};color:#fff;padding:1px 6px;border-radius:2px;font-weight:bold;font-size:10px;`;
  badge.textContent = analysis.riskLevel;
  statusBar.prepend(badge);

  // Add AI summary banner to diff body
  const diffBody = document.querySelector(".vsc-diff-body");
  if (diffBody && analysis.summary) {
    const banner = document.createElement("div");
    banner.className = "vsc-ai-banner";
    banner.style.cssText = `padding:8px 16px;background:rgba(0,122,204,0.15);border-left:3px solid ${color};color:${color};font-size:11px;margin:0;`;
    let text = `AI: ${analysis.summary}`;
    if (analysis.suggestion) text += ` — ${analysis.suggestion}`;
    banner.textContent = text;
    const firstBanner = diffBody.querySelector(".diff-banner");
    if (firstBanner) firstBanner.after(banner);
    else diffBody.prepend(banner);
  }
}

// ═══════════════════════════════════════════
// AUDIT RESULT (shown after analysis completes)
// ═══════════════════════════════════════════
function showAuditResult(analysis) {
  const crawlEl = document.getElementById("code-crawl");
  const contentEl = document.getElementById("crawl-content");
  const headerName = document.getElementById("crawl-file-name");
  const headerStatus = document.getElementById("crawl-status");

  // Stop any diff scroll animation
  if (diffScrollAnim) { cancelAnimationFrame(diffScrollAnim); diffScrollAnim = null; }

  const isSafe = analysis.riskLevel === "SAFE" || analysis.riskLevel === "LOW";

  if (isSafe) {
    // ── ALL CLEAR: clean audit passed ──
    headerName.textContent = "AUDIT COMPLETE";
    headerStatus.textContent = "ALL CLEAR";
    headerStatus.style.color = "#30d158";
    headerStatus.className = "";

    contentEl.innerHTML = `
      <div class="audit-result audit-clear">
        <div class="audit-icon">✓</div>
        <div class="audit-title">안전하게 수정되었습니다</div>
        <div class="audit-detail">파일 간, DB 간, 구조 간 아무런 문제 없습니다.</div>
        <div class="audit-file">${analysis.file}</div>
        <div class="audit-meta">${analysis.affectedNodes?.length || 0} files checked · ${analysis.analysisMs}ms</div>
      </div>`;

    // Keep showing audit result — don't hide code crawl
  } else {
    // ── WARNING: issues found — keep showing ──
    headerName.textContent = analysis.file;
    const riskColors = { CRITICAL: "#ff0040", HIGH: "#ff2d55", MEDIUM: "#ff9f0a" };
    headerStatus.textContent = `${analysis.riskLevel} — 확인 필요`;
    headerStatus.style.color = riskColors[analysis.riskLevel] || "#ff9f0a";
    headerStatus.className = "";

    // Keep existing diff content but prepend a warning summary
    const banner = document.createElement("div");
    banner.className = "audit-result audit-warning";
    banner.innerHTML = `
      <div class="audit-icon">!</div>
      <div class="audit-title">${analysis.riskLevel} — Attention Required</div>
      <div class="audit-detail">${analysis.summary}</div>
      ${analysis.suggestion ? `<div class="audit-suggestion">${analysis.suggestion}</div>` : ""}
      <div class="audit-wait-notice">Security warnings are expected during active modifications. Please wait until all changes are complete before taking action.</div>
    `;
    contentEl.prepend(banner);
  }
}

// REAL-TIME AI CODE MODIFICATION API
// ═══════════════════════════════════════════

window.syke = {
  // Mark a node as "being modified" — pulses orange
  startModifying(fileId) {
    modifyingNodes.add(fileId);
    const statusEl = document.getElementById("crawl-status");
    statusEl.textContent = "AI MODIFYING";
    statusEl.className = "modifying";
    // Continuous color refresh for pulsing effect
    if (!this._pulseInterval) {
      this._pulseInterval = setInterval(() => {
        if (modifyingNodes.size > 0 && Graph) {
          Graph.nodeColor(Graph.nodeColor());
        }
      }, 100);
    }
    // Dim non-protagonist nodes/particles immediately
    refreshGraph();
  },

  // Mark a node as done modifying
  stopModifying(fileId) {
    modifyingNodes.delete(fileId);
    if (modifyingNodes.size === 0) {
      const statusEl = document.getElementById("crawl-status");
      statusEl.textContent = "IDLE";
      statusEl.className = "";
      if (this._pulseInterval) {
        clearInterval(this._pulseInterval);
        this._pulseInterval = null;
      }
      // Restore all nodes/particles to normal
      refreshGraph();
    }
  },

  // Push a code change into the crawl
  // type: "modified" | "added" | "deleted" | "error-line"
  pushCodeChange({ file, line, type, content }) {
    const contentEl = document.getElementById("crawl-content");
    if (!contentEl) return;

    // Find existing line and highlight it
    const existing = contentEl.querySelector(
      `.crawl-line[data-file="${file}"][data-line="${line}"]`
    );
    if (existing) {
      existing.className = `crawl-line ${type}`;
      if (content !== undefined) {
        const escaped = content.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        existing.innerHTML = `<span class="cl-num">${line}</span>${escaped}`;
      }
      return;
    }

    // If line not found in current crawl, inject it at the top
    const col = LAYER_HEX[this._getLayer(file)] || "#00d4ff";
    const escaped = (content || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const div = document.createElement("div");
    div.className = `crawl-line ${type}`;
    div.dataset.file = file;
    div.dataset.line = line;
    div.innerHTML = `<span class="cl-num">${line}</span><span style="color:${col};opacity:0.4;margin-right:4px">[${file.split("/").pop()}]</span>${escaped}`;

    // Insert at the beginning of crawl
    if (contentEl.firstChild) {
      contentEl.insertBefore(div, contentEl.firstChild);
    } else {
      contentEl.appendChild(div);
    }

    // Update total height
    crawlTotalHeight = contentEl.scrollHeight;
  },

  // Push an error notification
  pushError({ file, line, message }) {
    this.pushCodeChange({
      file,
      line: line || 0,
      type: "error-line",
      content: `// ERROR: ${message}`,
    });

    // Also flash the node
    const node = graphData?.nodes.find(n => n.id === file);
    if (node) {
      modifyingNodes.add(file);
      setTimeout(() => {
        modifyingNodes.delete(file);
        if (Graph) Graph.nodeColor(Graph.nodeColor());
      }, 3000);
    }
  },

  // Helper
  _getLayer(fileId) {
    const node = graphData?.nodes.find(n => n.id === fileId);
    return node ? node.layer : "UTIL";
  },

  _pulseInterval: null,
};

// ═══════════════════════════════════════════
// SSE: REAL-TIME FILE MONITORING
// ═══════════════════════════════════════════
let sseSource = null;
let sseReconnectTimer = null;
let sseBlocked = false;
let sseEverConnected = false; // track if SSE has ever connected successfully
const realtimeLog = []; // recent events for panel

async function initSSE() {
  if (sseSource) { sseSource.close(); sseSource = null; }

  // Show appropriate status based on whether we've connected before
  if (!sseEverConnected) {
    updateSSEStatus("CONNECTING...", "warning");
  }

  // Pre-check: if Free tier, SSE will 403 — don't attempt connection
  try {
    const probe = await fetch("/api/events");
    if (probe.status === 403) {
      updateSSEStatus("PRO ONLY", "offline");
      sseBlocked = true;
      return;
    }
    // Close the successful probe connection (we'll open EventSource next)
    if (probe.body) probe.body.cancel().catch(() => {});
  } catch(e) {
    // Server not ready yet — retry after short delay on first attempt
    if (!sseEverConnected) {
      if (sseReconnectTimer) clearTimeout(sseReconnectTimer);
      sseReconnectTimer = setTimeout(() => { initSSE(); }, 2000);
      return;
    }
  }

  sseSource = new EventSource("/api/events");

  sseSource.addEventListener("connected", (e) => {
    const data = JSON.parse(e.data);
    console.log("[SYKE:SSE] Connected, cache:", data.cacheSize, "files");
    healthFailCount = 0; // Reset health failures on SSE connect
    sseEverConnected = true;
    updateSSEStatus("LIVE", "connected");
  });

  sseSource.addEventListener("file-change", (e) => {
    const data = JSON.parse(e.data);
    console.log("[SYKE:SSE] File change:", data.file, data.type, data.diffCount, "diffs");

    // ── 0. Update file tree modification tracking ──
    fileTreeModified.set(data.file, { type: data.type, timestamp: Date.now() });
    renderFileTreeDebounced();
    // Auto-clear pulse after pulseDuration
    const pulseDur = (SETTINGS.fileTree.pulseDuration || 5) * 1000;
    setTimeout(() => {
      fileTreeModified.delete(data.file);
      renderFileTreeDebounced();
    }, pulseDur);

    // ── 1. Auto-select the modified node in 3D graph ──
    selectedFile = data.file;
    selectedNodeId = data.file;
    highlightNodes.clear();
    highlightNodes.add(data.file);
    if (data.connectedNodes) {
      data.connectedNodes.forEach(id => highlightNodes.add(id));
    }

    // ── 2. Focus camera on the modified node ──
    focusCameraOnNode(data.file);

    // ── 3. Pulse the modified node (bright orange) ──
    window.syke.startModifying(data.file);

    // ── 4. Start heartbeat on connected nodes (risk TBD, will upgrade after analysis) ──
    if (data.connectedNodes && data.connectedNodes.length > 0) {
      startHeartbeat(data.connectedNodes, "MEDIUM"); // temporary risk, upgraded after analysis
    }

    // ── 5. Show real-time diff with animated scroll ──
    showRealtimeDiff(data);

    // ── 6. Highlight connected links ──
    highlightLinks.clear();
    graphData.links.forEach(l => {
      if (highlightNodes.has(getSrcId(l)) && highlightNodes.has(getTgtId(l))) highlightLinks.add(l);
    });
    refreshGraph();

    addRealtimeEvent({
      type: "change",
      file: data.file,
      changeType: data.type,
      diffCount: data.diffCount,
      timestamp: data.timestamp,
    });

    updateSSEStatus("CHANGE DETECTED", "warning");
  });

  sseSource.addEventListener("analysis-start", (e) => {
    const data = JSON.parse(e.data);
    console.log("[SYKE:SSE] AI analyzing:", data.file);
    updateSSEStatus("AI ANALYZING...", "analyzing");

    addRealtimeEvent({
      type: "analyzing",
      file: data.file,
      timestamp: Date.now(),
    });
  });

  sseSource.addEventListener("analysis-result", (e) => {
    const analysis = JSON.parse(e.data);
    console.log("[SYKE:SSE] Analysis result:", analysis.file, analysis.riskLevel);

    // ── Stop modifying pulse on the changed file ──
    setTimeout(() => window.syke.stopModifying(analysis.file), 2000);

    // ── Upgrade heartbeat to real risk level from Gemini ──
    // Stop the temporary MEDIUM heartbeat and restart with actual risk
    const connectedIds = analysis.affectedNodes || [];
    stopHeartbeat(connectedIds);

    if (connectedIds.length > 0 && analysis.riskLevel !== "SAFE") {
      startHeartbeat(connectedIds, analysis.riskLevel);

      // Duration based on severity
      const duration = analysis.riskLevel === "CRITICAL" ? 15000
        : analysis.riskLevel === "HIGH" ? 10000
        : analysis.riskLevel === "MEDIUM" ? 6000
        : 3000;

      setTimeout(() => stopHeartbeat(connectedIds), duration);
    }

    // Show warnings in code crawl
    if (analysis.warnings && analysis.warnings.length > 0) {
      analysis.warnings.forEach(w => {
        window.syke.pushError({ file: analysis.file, line: 0, message: w });
      });
    }

    // Update diff view with analysis risk badge
    updateDiffWithAnalysis(analysis);
    // Also update CODE tab with analysis result
    updateCodeTabAnalysis(analysis);

    addRealtimeEvent({
      type: "result",
      file: analysis.file,
      riskLevel: analysis.riskLevel,
      summary: analysis.summary,
      brokenImports: analysis.brokenImports,
      sideEffects: analysis.sideEffects,
      warnings: analysis.warnings,
      suggestion: analysis.suggestion,
      affectedCount: analysis.affectedNodes?.length || 0,
      analysisMs: analysis.analysisMs,
      timestamp: analysis.timestamp,
    });

    // Update status with risk level
    const statusMap = {
      CRITICAL: ["CRITICAL RISK", "critical"],
      HIGH: ["HIGH RISK", "danger"],
      MEDIUM: ["MEDIUM RISK", "warning"],
      LOW: ["LOW RISK", "safe"],
      SAFE: ["SAFE", "connected"],
    };
    const [text, cls] = statusMap[analysis.riskLevel] || ["ANALYZED", "connected"];
    updateSSEStatus(text, cls);

    // ── Auto-clear code crawl + show ALL CLEAR after analysis ──
    const isSafe = analysis.riskLevel === "SAFE" || analysis.riskLevel === "LOW";
    const clearDelay = analysis.riskLevel === "CRITICAL" ? 15000
      : analysis.riskLevel === "HIGH" ? 10000
      : analysis.riskLevel === "MEDIUM" ? 8000
      : 5000; // SAFE/LOW: 5s then clear

    setTimeout(() => {
      // Clear code crawl panel — show ALL CLEAR or warning summary
      showAuditResult(analysis);
      // Clear selected node highlight
      if (isSafe) {
        highlightNodes.clear();
        highlightLinks.clear();
        selectedFile = null;
        selectedNodeId = null;
        refreshGraph();
      }
      updateSSEStatus("LIVE", "connected");
    }, clearDelay);

    // Update the realtime panel
    renderRealtimePanel();
  });

  sseSource.addEventListener("analysis-error", (e) => {
    const data = JSON.parse(e.data);
    console.error("[SYKE:SSE] Analysis error:", data.file, data.error);
    window.syke.stopModifying(data.file);
    updateSSEStatus("AI ERROR", "critical");
    setTimeout(() => updateSSEStatus("LIVE", "connected"), 5000);
  });

  sseSource.addEventListener("graph-rebuild", (e) => {
    const data = JSON.parse(e.data);
    console.log("[SYKE:SSE] Graph rebuild triggered:", data.reason, data.file);
    // Reload graph data after a short delay
    setTimeout(async () => {
      await loadGraph();
      await loadHubFiles();
      renderFileTreeDebounced();
    }, 1000);
  });

  sseSource.addEventListener("project-switched", (e) => {
    const data = JSON.parse(e.data);
    console.log("[SYKE:SSE] Project switched:", data.projectRoot);
    loadProjectInfo();
    loadGraph();
    loadHubFiles();
    updateSSEStatus("PROJECT LOADED", "connected");
  });

  let sseRetryCount = 0;
  sseSource.onerror = async () => {
    console.warn("[SYKE:SSE] Connection error, retry #" + (sseRetryCount + 1));
    sseSource.close();
    sseSource = null;
    if (sseBlocked) return;

    sseRetryCount++;
    updateSSEStatus(sseEverConnected ? "RECONNECTING..." : "CONNECTING...", "warning");

    // Only show offline after 5 consecutive SSE failures
    if (sseRetryCount >= 5) {
      try {
        const probe = await fetch("/api/project-info", { signal: AbortSignal.timeout(8000) });
        if (!probe.ok) throw new Error("not ok");
        // Server alive but SSE failing — just keep retrying
        sseRetryCount = 0;
      } catch (e) {
        showServerOffline();
      }
    }

    // Exponential backoff: 2s, 4s, 8s, 16s, max 30s
    const delay = Math.min(2000 * Math.pow(2, sseRetryCount - 1), 30000);
    if (sseReconnectTimer) clearTimeout(sseReconnectTimer);
    sseReconnectTimer = setTimeout(() => {
      initSSE();
    }, delay);
  };
}

function updateSSEStatus(text, className) {
  const dot = document.querySelector(".pulse-dot");
  const indicator = document.getElementById("sse-status");
  if (dot) {
    dot.className = "pulse-dot " + (className || "");
  }
  if (indicator) {
    indicator.textContent = text;
    indicator.className = "sse-indicator " + (className || "");
  }
}

function addRealtimeEvent(event) {
  realtimeLog.unshift(event);
  if (realtimeLog.length > 50) realtimeLog.pop();
  renderRealtimePanel();
}

function renderRealtimePanel() {
  const panel = document.getElementById("realtime-log");
  if (!panel) return;

  if (realtimeLog.length === 0) {
    panel.innerHTML = '<p class="placeholder">Waiting for file changes...</p>';
    return;
  }

  let html = "";
  for (const evt of realtimeLog.slice(0, 20)) {
    const time = new Date(evt.timestamp).toLocaleTimeString();

    if (evt.type === "change") {
      const icon = evt.changeType === "added" ? "+" : evt.changeType === "deleted" ? "x" : "~";
      html += `<div class="rt-event rt-${evt.changeType}">
        <span class="rt-time">${time}</span>
        <span class="rt-icon">${icon}</span>
        <span class="rt-file">${evt.file}</span>
        <span class="rt-diff">${evt.diffCount} changes</span>
      </div>`;
    } else if (evt.type === "analyzing") {
      html += `<div class="rt-event rt-analyzing">
        <span class="rt-time">${time}</span>
        <span class="rt-icon">&#9881;</span>
        <span class="rt-msg">AI analyzing ${evt.file}...</span>
      </div>`;
    } else if (evt.type === "result") {
      const riskCls = evt.riskLevel === "CRITICAL" ? "critical" : evt.riskLevel === "HIGH" ? "danger" : evt.riskLevel === "MEDIUM" ? "warning" : "safe";
      html += `<div class="rt-event rt-result rt-${riskCls}">
        <span class="rt-time">${time}</span>
        <span class="rt-risk ${riskCls}">${evt.riskLevel}</span>
        <span class="rt-file">${evt.file}</span>
        <span class="rt-ms">${evt.analysisMs}ms</span>
      </div>`;
      if (evt.summary) {
        html += `<div class="rt-detail">${evt.summary}</div>`;
      }
      if (evt.brokenImports && evt.brokenImports.length > 0) {
        html += `<div class="rt-detail rt-broken">BROKEN: ${evt.brokenImports.join(", ")}</div>`;
      }
      if (evt.warnings && evt.warnings.length > 0) {
        evt.warnings.forEach(w => {
          html += `<div class="rt-detail rt-warn">${w}</div>`;
        });
      }
      if (evt.suggestion) {
        html += `<div class="rt-detail rt-suggestion">${evt.suggestion}</div>`;
      }
    }
  }

  panel.innerHTML = html;
}

// ═══════════════════════════════════════════
// RESIZABLE RIGHT PANEL
// ═══════════════════════════════════════════
// ═══════════════════════════════════════════
// FILE TREE PANEL
// ═══════════════════════════════════════════

function getGraphPanelWidth() {
  const rightPanel = document.getElementById("right-panel");
  const treePanel = document.getElementById("file-tree-panel");
  const rw = rightPanel ? rightPanel.offsetWidth : 380;
  const tw = (treePanel && !treePanel.classList.contains("hidden")) ? treePanel.offsetWidth : 0;
  // 8px per resize handle (tree + right)
  return window.innerWidth - rw - tw - 16;
}

function updateDynamicRightOffsets() {
  const rightPanel = document.getElementById("right-panel");
  const treePanel = document.getElementById("file-tree-panel");
  const rw = rightPanel ? rightPanel.offsetWidth : 380;
  const tw = (treePanel && !treePanel.classList.contains("hidden")) ? treePanel.offsetWidth : 0;
  const total = rw + tw + 16; // 2 resize handles × 8px
  document.documentElement.style.setProperty("--right-offset", total + "px");
}

function toggleFileTreePanel() {
  const panel = document.getElementById("file-tree-panel");
  const treeResize = document.getElementById("tree-resize-handle");
  if (!panel) return;
  fileTreeVisible = !fileTreeVisible;
  panel.classList.toggle("hidden", !fileTreeVisible);
  if (treeResize) treeResize.style.display = fileTreeVisible ? "" : "none";
  updateDynamicRightOffsets();
  if (Graph) {
    const gp = document.getElementById("graph-panel");
    if (gp) Graph.width(gp.clientWidth);
  }
}

function buildFileTree(nodes) {
  if (!nodes || !nodes.length) { fileTreeData = null; return; }
  const root = { name: "", children: {}, files: [], path: "" };

  nodes.forEach(n => {
    const parts = (n.fullPath || n.id).split("/").filter(Boolean);
    let current = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const folderName = parts[i];
      const folderPath = parts.slice(0, i + 1).join("/");
      if (!current.children[folderName]) {
        current.children[folderName] = { name: folderName, children: {}, files: [], path: folderPath };
      }
      current = current.children[folderName];
    }
    current.files.push({
      name: parts[parts.length - 1] || n.label,
      node: n,
      path: n.fullPath || n.id,
    });
  });

  fileTreeData = root;
}

function countFilesRecursive(folder) {
  let count = folder.files.length;
  for (const child of Object.values(folder.children)) {
    count += countFilesRecursive(child);
  }
  return count;
}

function getAggregateRisk(folder) {
  const order = ["HIGH", "MEDIUM", "LOW", "NONE"];
  let highest = 3; // NONE
  for (const f of folder.files) {
    const idx = order.indexOf(f.node.riskLevel);
    if (idx >= 0 && idx < highest) highest = idx;
  }
  for (const child of Object.values(folder.children)) {
    const childRisk = getAggregateRisk(child);
    const idx = order.indexOf(childRisk);
    if (idx >= 0 && idx < highest) highest = idx;
  }
  return order[highest];
}

function folderHasModifiedChild(folder) {
  for (const f of folder.files) {
    if (fileTreeModified.has(f.path)) return true;
  }
  for (const child of Object.values(folder.children)) {
    if (folderHasModifiedChild(child)) return true;
  }
  return false;
}

function folderMatchesFilter(folder, filter) {
  if (!filter) return true;
  const fl = filter.toLowerCase();
  for (const f of folder.files) {
    if (f.name.toLowerCase().includes(fl) || f.path.toLowerCase().includes(fl)) return true;
  }
  for (const child of Object.values(folder.children)) {
    if (child.name.toLowerCase().includes(fl) || folderMatchesFilter(child, filter)) return true;
  }
  return false;
}

function sortTreeItems(items, sortType) {
  return [...items].sort((a, b) => {
    switch (sortType) {
      case "layer": {
        const la = a.node ? (a.node.layer || "UTIL") : "";
        const lb = b.node ? (b.node.layer || "UTIL") : "";
        return la.localeCompare(lb) || (a.name || "").localeCompare(b.name || "");
      }
      case "risk": {
        const order = { HIGH: 0, MEDIUM: 1, LOW: 2, NONE: 3 };
        const ra = a.node ? (order[a.node.riskLevel] ?? 3) : 3;
        const rb = b.node ? (order[b.node.riskLevel] ?? 3) : 3;
        return ra - rb || (a.name || "").localeCompare(b.name || "");
      }
      case "deps": {
        const da = a.node ? (a.node.dependentCount || 0) : 0;
        const db = b.node ? (b.node.dependentCount || 0) : 0;
        return db - da || (a.name || "").localeCompare(b.name || "");
      }
      case "modified": {
        const ma = a.path && fileTreeModified.has(a.path) ? fileTreeModified.get(a.path).timestamp : 0;
        const mb = b.path && fileTreeModified.has(b.path) ? fileTreeModified.get(b.path).timestamp : 0;
        return mb - ma || (a.name || "").localeCompare(b.name || "");
      }
      default: // name
        return (a.name || "").localeCompare(b.name || "");
    }
  });
}

function renderFileTree() {
  if (!graphData || !graphData.nodes) return;
  buildFileTree(graphData.nodes);
  if (!fileTreeData) return;

  const container = document.getElementById("tree-content");
  const countEl = document.getElementById("tree-file-count");
  if (!container) return;

  const s = SETTINGS.fileTree;
  const filter = fileTreeFilter.toLowerCase();
  let totalFiles = 0;

  // Nested rendering: each folder level produces a <div class="tree-group">
  function renderGroup(folder) {
    // Collect visible items (folders first, then files)
    const visibleFolders = Object.values(folder.children)
      .filter(c => !filter || folderMatchesFilter(c, filter))
      .sort((a, b) => a.name.localeCompare(b.name));

    const visibleFiles = sortTreeItems(
      folder.files.filter(f => !filter || f.name.toLowerCase().includes(filter) || f.path.toLowerCase().includes(filter)),
      fileTreeSort
    );

    const itemCount = visibleFolders.length + visibleFiles.length;
    if (itemCount === 0) return "";

    const hasModified = folderHasModifiedChild(folder);
    const singleClass = itemCount === 1 ? " single-child" : "";
    const modGroupClass = hasModified ? " has-modified" : "";
    let html = `<div class="tree-group${singleClass}${modGroupClass}">`;

    // ── Folders ──
    for (const child of visibleFolders) {
      const isOpen = fileTreeExpanded.has(child.path);
      const fileCount = countFilesRecursive(child);
      const hasModChild = folderHasModifiedChild(child);
      const compactClass = s.compactMode ? " compact" : "";
      const glowClass = hasModChild ? " folder-glow" : "";
      const col = "var(--accent)";

      html += `<div class="tree-node${glowClass}${compactClass}" data-path="${child.path}" data-type="folder">`;
      html += `<div class="tree-dot" style="border-color:${col};box-shadow:0 0 8px rgba(0,212,255,0.4)"></div>`;
      html += `<span class="tree-toggle${isOpen ? " open" : ""}" data-path="${child.path}">&#9654;</span>`;
      html += `<span class="tree-name folder-name">${escHtml(child.name)}</span>`;
      html += `<span class="tree-folder-count">${fileCount}</span>`;
      html += `</div>`;

      // Render expanded children as nested tree-group
      if (isOpen) {
        html += renderGroup(child);
      }
    }

    // ── Files ──
    for (const f of visibleFiles) {
      totalFiles++;
      const isSelected = selectedNodeId === f.node.id;
      const isModified = fileTreeModified.has(f.path);
      const modData = isModified ? fileTreeModified.get(f.path) : null;
      const col = LAYER_HEX[f.node.layer] || "#999";
      const compactClass = s.compactMode ? " compact" : "";
      const selClass = isSelected ? " selected" : "";
      const modClass = isModified ? " modified" : "";

      html += `<div class="tree-node${selClass}${modClass}${compactClass}" style="font-size:${s.fontSize}px" data-path="${f.path}" data-node-id="${f.node.id}" data-type="file">`;
      html += `<div class="tree-dot" style="background:${col};border-color:${col};box-shadow:0 0 8px ${col}"></div>`;
      html += `<span class="tree-name">${escHtml(f.name)}</span>`;

      // Badges
      if (isModified && modData) {
        const modLabel = modData.type === "added" ? "A" : modData.type === "deleted" ? "D" : "M";
        const modCls = modData.type === "added" ? "mod-A" : modData.type === "deleted" ? "mod-D" : "mod-M";
        html += `<span class="tree-mod-badge ${modCls}">${modLabel}</span>`;
      }
      if (s.showRisk && f.node.riskLevel && f.node.riskLevel !== "NONE") {
        html += `<span class="tree-badge badge-risk-${f.node.riskLevel}">${f.node.riskLevel[0]}</span>`;
      }
      if (s.showDeps && f.node.dependentCount > 0) {
        html += `<span class="tree-badge badge-deps">D${f.node.dependentCount}</span>`;
      }
      if (s.showLineCount && f.node.lineCount > 0) {
        html += `<span class="tree-badge badge-lines">L${f.node.lineCount}</span>`;
      }
      html += `</div>`;
    }

    html += `</div>`; // close tree-group
    return html;
  }

  container.innerHTML = renderGroup(fileTreeData);
  if (countEl) countEl.textContent = totalFiles;
}

function escHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function renderFileTreeDebounced() {
  if (_fileTreeRenderTimer) clearTimeout(_fileTreeRenderTimer);
  _fileTreeRenderTimer = setTimeout(() => {
    renderFileTree();
    _fileTreeRenderTimer = null;
  }, 100);
}

function toggleFolder(path) {
  if (fileTreeExpanded.has(path)) fileTreeExpanded.delete(path);
  else fileTreeExpanded.add(path);
  renderFileTree();
}

function expandAllFolders() {
  if (!fileTreeData) return;
  function collectPaths(folder) {
    for (const child of Object.values(folder.children)) {
      fileTreeExpanded.add(child.path);
      collectPaths(child);
    }
  }
  collectPaths(fileTreeData);
  renderFileTree();
}

function collapseAllFolders() {
  fileTreeExpanded.clear();
  renderFileTree();
}

function treeScrollToFile(nodeId) {
  if (!fileTreeData || !nodeId || _treeScrollLock) return;
  // Find file path and expand parent folders
  const node = graphData?.nodes.find(n => n.id === nodeId);
  if (!node) return;
  const fullPath = node.fullPath || nodeId;
  const parts = fullPath.split("/").filter(Boolean);

  // Expand all parent folders
  for (let i = 1; i < parts.length; i++) {
    const folderPath = parts.slice(0, i).join("/");
    fileTreeExpanded.add(folderPath);
  }

  renderFileTree();

  // Scroll to the file element
  requestAnimationFrame(() => {
    const container = document.getElementById("tree-scroll-container");
    const el = document.querySelector(`[data-node-id="${CSS.escape(nodeId)}"]`);
    if (el && container && SETTINGS.fileTree.autoScrollOnChange) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  });
}

function applyFileTreeSettings() {
  const panel = document.getElementById("file-tree-panel");
  if (panel) {
    const w = SETTINGS.fileTree.panelWidth;
    panel.style.flex = `0 0 ${w}px`;
    panel.style.width = `${w}px`;
  }
  updateDynamicRightOffsets();
  renderFileTree();
  if (Graph) {
    const gp = document.getElementById("graph-panel");
    if (gp) Graph.width(gp.clientWidth);
  }
}

function setupFileTree() {
  const container = document.getElementById("tree-content");
  const searchInput = document.getElementById("tree-search-input");
  const sortBtn = document.getElementById("tree-sort-btn");
  const sortMenu = document.getElementById("tree-sort-menu");
  const collapseBtn = document.getElementById("tree-collapse-all");
  const scrollContainer = document.getElementById("tree-scroll-container");

  if (!container) return;

  // Click delegation for tree nodes
  container.addEventListener("click", (e) => {
    const node = e.target.closest(".tree-node");
    if (!node) return;

    if (node.dataset.type === "folder") {
      toggleFolder(node.dataset.path);
      return;
    }

    // File click → select in 3D graph
    const nodeId = node.dataset.nodeId;
    if (nodeId && graphData) {
      const gNode = graphData.nodes.find(n => n.id === nodeId);
      if (gNode) {
        handleNodeClick(gNode);
      }
    }
  });

  // Toggle arrow click
  container.addEventListener("click", (e) => {
    const toggle = e.target.closest(".tree-toggle");
    if (toggle) {
      e.stopPropagation();
      toggleFolder(toggle.dataset.path);
    }
  });

  // Hover → highlight 3D node
  container.addEventListener("mouseenter", (e) => {
    const node = e.target.closest(".tree-node[data-type='file']");
    if (!node || !Graph) return;
    const nodeId = node.dataset.nodeId;
    if (nodeId) {
      highlightNodes.add(nodeId);
      refreshGraph();
    }
  }, true);

  container.addEventListener("mouseleave", (e) => {
    const node = e.target.closest(".tree-node[data-type='file']");
    if (!node || !Graph) return;
    const nodeId = node.dataset.nodeId;
    if (nodeId && nodeId !== selectedNodeId) {
      highlightNodes.delete(nodeId);
      refreshGraph();
    }
  }, true);

  // Search filter
  if (searchInput) {
    searchInput.addEventListener("input", () => {
      fileTreeFilter = searchInput.value.trim();
      // Auto-expand when filtering
      if (fileTreeFilter && fileTreeData) expandAllFolders();
      else renderFileTree();
    });
  }

  // Sort button + menu
  if (sortBtn && sortMenu) {
    sortBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      sortMenu.classList.toggle("hidden");
    });

    sortMenu.querySelectorAll(".tree-sort-option").forEach(opt => {
      opt.addEventListener("click", (e) => {
        e.stopPropagation();
        fileTreeSort = opt.dataset.sort;
        sortMenu.querySelectorAll(".tree-sort-option").forEach(o => o.classList.remove("active"));
        opt.classList.add("active");
        sortMenu.classList.add("hidden");
        renderFileTree();
      });
    });

    // Close sort menu on outside click
    document.addEventListener("click", () => {
      if (sortMenu) sortMenu.classList.add("hidden");
    });
  }

  // Collapse/expand all toggle
  let allExpanded = false;
  if (collapseBtn) {
    collapseBtn.addEventListener("click", () => {
      if (allExpanded) { collapseAllFolders(); collapseBtn.innerHTML = "&#9660;"; }
      else { expandAllFolders(); collapseBtn.innerHTML = "&#9650;"; }
      allExpanded = !allExpanded;
    });
  }

  // Scroll lock: disable auto-scroll when user manually scrolls
  if (scrollContainer) {
    scrollContainer.addEventListener("scroll", () => {
      _treeScrollLock = true;
      if (_treeScrollLockTimer) clearTimeout(_treeScrollLockTimer);
      _treeScrollLockTimer = setTimeout(() => { _treeScrollLock = false; }, 3000);
    }, { passive: true });
  }

  // Apply initial settings
  applyFileTreeSettings();
  updateDynamicRightOffsets();
}

function setupTreeResizeHandle() {
  const handle = document.getElementById("tree-resize-handle");
  const panel = document.getElementById("file-tree-panel");
  if (!handle || !panel) return;

  let startX = 0;
  let startW = 0;

  function onMove(e) {
    e.preventDefault();
    const dx = e.clientX - startX;
    const newW = Math.max(200, Math.min(500, startW + dx));
    panel.style.flex = "0 0 " + newW + "px";
    panel.style.width = newW + "px";
    SETTINGS.fileTree.panelWidth = newW;
    updateDynamicRightOffsets();
    if (Graph) {
      const gp = document.getElementById("graph-panel");
      if (gp) Graph.width(gp.clientWidth);
    }
  }

  function onUp() {
    window.removeEventListener("mousemove", onMove, true);
    window.removeEventListener("mouseup", onUp, true);
    handle.classList.remove("dragging");
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    const overlay = document.getElementById("tree-resize-overlay");
    if (overlay) overlay.remove();
    saveSettings();
    if (Graph) {
      const gp = document.getElementById("graph-panel");
      if (gp) Graph.width(gp.clientWidth);
    }
  }

  handle.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    startX = e.clientX;
    startW = panel.offsetWidth;
    handle.classList.add("dragging");
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    const overlay = document.createElement("div");
    overlay.id = "tree-resize-overlay";
    overlay.style.cssText = "position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:9999;cursor:col-resize;background:transparent;";
    document.body.appendChild(overlay);
    window.addEventListener("mousemove", onMove, true);
    window.addEventListener("mouseup", onUp, true);
  });
}

// ═══════════════════════════════════════════
// RESIZE HANDLE (Right Panel)
// ═══════════════════════════════════════════
function setupResizeHandle() {
  const handle = document.getElementById("resize-handle");
  const panel = document.getElementById("right-panel");
  const hub = document.getElementById("hub-drawer");
  if (!handle || !panel) return;

  let startX = 0;
  let startW = 0;

  function onMove(e) {
    e.preventDefault();
    const dx = startX - e.clientX;
    const newW = Math.max(250, Math.min(900, startW + dx));
    panel.style.flex = "0 0 " + newW + "px";
    panel.style.width = newW + "px";
    updateDynamicRightOffsets();
    if (Graph) {
      const gp = document.getElementById("graph-panel");
      if (gp) Graph.width(gp.clientWidth);
    }
  }

  function onUp() {
    window.removeEventListener("mousemove", onMove, true);
    window.removeEventListener("mouseup", onUp, true);
    handle.classList.remove("dragging");
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    document.body.style.pointerEvents = "";
    const overlay = document.getElementById("resize-overlay");
    if (overlay) overlay.remove();
    if (Graph) {
      const gp = document.getElementById("graph-panel");
      if (gp) Graph.width(gp.clientWidth);
    }
  }

  handle.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    startX = e.clientX;
    startW = panel.offsetWidth;
    handle.classList.add("dragging");
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    // Full-screen overlay prevents canvas from stealing events
    const overlay = document.createElement("div");
    overlay.id = "resize-overlay";
    overlay.style.cssText = "position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:9999;cursor:col-resize;background:transparent;";
    document.body.appendChild(overlay);
    // Capture-phase listeners on window — nothing can intercept
    window.addEventListener("mousemove", onMove, true);
    window.addEventListener("mouseup", onUp, true);
  });
}

// ═══════════════════════════════════════════
// PROJECT SELECTOR
// ═══════════════════════════════════════════
function updateLicenseBadge(plan, expiresAt) {
  const badge = document.getElementById("license-badge");
  if (!badge) return;

  badge.className = "license-badge";

  if (plan === "pro" || plan === "pro_trial") {
    if (expiresAt && new Date(expiresAt) < new Date()) {
      badge.classList.add("expired");
      badge.textContent = "EXPIRED";
    } else if (plan === "pro_trial") {
      badge.classList.add("pro");
      badge.textContent = "TRIAL-PRO";
    } else {
      badge.classList.add("pro");
      badge.textContent = "PRO";
    }
  } else {
    badge.classList.add("free");
    badge.textContent = "FREE";
  }
}

let offlineRetryTimer = null;

function showServerOffline() {
  const overlay = document.getElementById("server-offline-overlay");
  if (overlay) overlay.classList.remove("hidden");
  // Hide other content
  const topbar = document.getElementById("topbar");
  if (topbar) topbar.style.opacity = "0.2";

  // Auto-retry every 3 seconds
  if (!offlineRetryTimer) {
    offlineRetryTimer = setInterval(async () => {
      const retryEl = document.getElementById("offline-retry-status");
      try {
        const res = await fetch("/api/project-info");
        if (res.ok) {
          // Server is back!
          clearInterval(offlineRetryTimer);
          offlineRetryTimer = null;
          hideServerOffline();
          await loadProjectInfo();
          await loadGraph();
          await loadHubFiles();
          initSSE();
        }
      } catch (e) {
        if (retryEl) retryEl.textContent = "Retrying connection... (" + new Date().toLocaleTimeString() + ")";
      }
    }, 3000);
  }
}

function hideServerOffline() {
  const overlay = document.getElementById("server-offline-overlay");
  if (overlay) overlay.classList.add("hidden");
  const topbar = document.getElementById("topbar");
  if (topbar) topbar.style.opacity = "1";
}

async function loadProjectInfo() {
  try {
    const res = await fetch("/api/project-info");
    const info = await res.json();
    const el = document.getElementById("current-project");
    if (el) {
      const short = info.projectRoot.length > 50
        ? "..." + info.projectRoot.slice(-47)
        : info.projectRoot;
      el.textContent = short;
      el.title = info.projectRoot + " | " + info.languages.join(", ") + " | " + info.fileCount + " files";
    }
    hideServerOffline();
    updateLicenseBadge(info.plan, info.expiresAt);
    updateLicenseButton(info.plan);
    // Bottom bar: fetch version from npm registry
    updateBottomBar();
  } catch (e) {
    console.warn("[SYKE] Failed to load project info:", e);
    // Don't immediately show offline — let health check handle it
  }
}

async function updateBottomBar() {
  const el = document.getElementById("bottom-info");
  if (!el) return;
  try {
    const r = await fetch("https://registry.npmjs.org/@syke1/mcp-server", { cache: "no-store" });
    const data = await r.json();
    const version = data["dist-tags"]?.latest || "?";
    const publishDate = data.time?.[version]?.slice(0, 10) || "?";
    el.textContent = "SYKE v" + version + " · Latest update " + publishDate;
  } catch {
    el.textContent = "SYKE";
  }
}

let browsePath = null; // current path in folder browser

async function browseDir(dirPath) {
  const listEl = document.getElementById("browse-dir-list");
  const pathEl = document.getElementById("browse-current-path");
  const infoEl = document.getElementById("project-detect-info");
  const loadBtn = document.getElementById("btn-project-load");
  const upBtn = document.getElementById("btn-browse-up");

  if (listEl) listEl.innerHTML = '<div class="browse-empty"><div class="spinner"></div> SCANNING...</div>';

  try {
    const url = dirPath ? `/api/browse-dirs?path=${encodeURIComponent(dirPath)}` : "/api/browse-dirs";
    const res = await fetch(url);
    const data = await res.json();

    if (!res.ok) {
      if (listEl) listEl.innerHTML = `<div class="browse-empty">ERROR: ${data.error}</div>`;
      return;
    }

    browsePath = data.current;
    if (pathEl) {
      pathEl.textContent = data.current;
      pathEl.title = data.current;
    }

    // Up button
    if (upBtn) upBtn.disabled = !data.parent;

    // Always allow selection, show project detection as hint
    if (loadBtn) loadBtn.disabled = false;
    if (data.isProject) {
      if (infoEl) {
        infoEl.className = "project-detected";
        infoEl.textContent = "PROJECT DETECTED (" + data.detectedMarker + ")";
      }
    } else {
      if (infoEl) {
        infoEl.className = "";
        infoEl.textContent = "";
      }
    }

    // Render directory list
    if (!data.dirs || data.dirs.length === 0) {
      if (listEl) listEl.innerHTML = '<div class="browse-empty">NO SUBDIRECTORIES</div>';
      return;
    }

    let html = "";
    for (const dir of data.dirs) {
      const fullPath = data.current.replace(/\\/g, "/").replace(/\/$/, "") + "/" + dir;
      html += '<div class="browse-dir-item" data-path="' + fullPath.replace(/"/g, "&quot;") + '">' +
        '<span class="dir-icon">&#128193;</span>' +
        '<span class="dir-name">' + dir + '</span></div>';
    }
    if (listEl) {
      listEl.innerHTML = html;
      listEl.querySelectorAll(".browse-dir-item").forEach(function(item) {
        item.addEventListener("click", function() { browseDir(item.dataset.path); });
      });
    }
  } catch (e) {
    if (listEl) listEl.innerHTML = '<div class="browse-empty">CONNECTION LOST — server may have restarted</div>';
  }
}

async function switchProject(projectPath) {
  const infoEl = document.getElementById("project-detect-info");
  const loadBtn = document.getElementById("btn-project-load");

  if (infoEl) {
    infoEl.className = "";
    infoEl.innerHTML = '<div class="project-loading"><div class="spinner"></div>LOADING PROJECT...</div>';
  }
  if (loadBtn) loadBtn.disabled = true;

  try {
    const res = await fetch("/api/switch-project", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectRoot: projectPath }),
    });
    const data = await res.json();

    if (!res.ok) {
      if (infoEl) {
        infoEl.className = "error";
        infoEl.textContent = data.error || "Failed to load project";
      }
      if (loadBtn) loadBtn.disabled = false;
      return;
    }

    if (infoEl) {
      infoEl.className = "success";
      infoEl.textContent = "LOADED: " + data.languages.join(", ") + " | " + data.fileCount + " files | " + data.edgeCount + " edges";
    }

    setTimeout(function() {
      document.getElementById("project-modal").classList.add("hidden");
      if (loadBtn) loadBtn.disabled = false;
    }, 800);

    await loadProjectInfo();
    await loadGraph();
    await loadHubFiles();
    handleBackgroundClick();

  } catch (e) {
    if (infoEl) {
      infoEl.className = "error";
      infoEl.textContent = "NETWORK ERROR: " + e.message;
    }
    if (loadBtn) loadBtn.disabled = false;
  }
}

// ══════════════════════════════════════════════════════════════
// LICENSE MODAL
// ══════════════════════════════════════════════════════════════
function setupLicenseModal() {
  const btn = document.getElementById("btn-license");
  const modal = document.getElementById("license-modal");
  const input = document.getElementById("license-key-input");
  const activateBtn = document.getElementById("btn-license-activate");
  const deactivateBtn = document.getElementById("btn-license-deactivate");
  const cancelBtn = document.getElementById("btn-license-cancel");
  const statusEl = document.getElementById("license-modal-status");
  if (!btn || !modal) return;

  async function openModal() {
    modal.classList.remove("hidden");
    input.value = "";
    statusEl.textContent = "";
    statusEl.className = "";
    // Fetch current key status
    try {
      const res = await fetch("/api/project-info");
      const info = await res.json();
      if (info.licenseKey) {
        input.placeholder = info.licenseKey;
        statusEl.className = "success";
        statusEl.textContent = "ACTIVE — " + (info.plan || "free").toUpperCase();
        deactivateBtn.style.display = "";
      } else {
        input.placeholder = "SYKE-XXXX-XXXX-XXXX-XXXX";
        deactivateBtn.style.display = "none";
      }
    } catch {
      input.placeholder = "SYKE-XXXX-XXXX-XXXX-XXXX";
    }
    input.focus();
  }
  function closeModal() {
    modal.classList.add("hidden");
  }

  btn.addEventListener("click", openModal);
  cancelBtn.addEventListener("click", closeModal);
  modal.addEventListener("click", (e) => { if (e.target === modal) closeModal(); });

  activateBtn.addEventListener("click", async () => {
    const key = input.value.trim();
    if (!key || !(key.startsWith("SYKE-") || key.startsWith("FOUNDING-"))) {
      statusEl.className = "error";
      statusEl.textContent = "Key must start with SYKE- or FOUNDING-";
      return;
    }
    statusEl.className = "loading";
    statusEl.textContent = "VALIDATING...";
    activateBtn.disabled = true;

    try {
      const res = await fetch("/api/set-license-key", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key }),
      });
      const data = await res.json();
      if (data.success && (data.plan === "pro" || data.plan === "pro_trial")) {
        statusEl.className = "success";
        statusEl.textContent = data.plan === "pro_trial" ? "TRIAL-PRO ACTIVATED" : "PRO ACTIVATED";
        updateLicenseBadge(data.plan, data.expiresAt);
        updateLicenseButton(data.plan);
        setTimeout(closeModal, 1200);
      } else {
        statusEl.className = "error";
        statusEl.textContent = data.error || "Activation failed";
      }
    } catch (err) {
      statusEl.className = "error";
      statusEl.textContent = "Network error";
    }
    activateBtn.disabled = false;
  });

  deactivateBtn.addEventListener("click", async () => {
    if (!confirm("Remove license key? Dashboard will switch to Free mode.")) return;
    statusEl.className = "loading";
    statusEl.textContent = "REMOVING...";

    try {
      const res = await fetch("/api/set-license-key", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: null }),
      });
      const data = await res.json();
      if (data.success) {
        statusEl.className = "success";
        statusEl.textContent = "KEY REMOVED";
        updateLicenseBadge("free", null);
        updateLicenseButton("free");
        setTimeout(closeModal, 800);
      }
    } catch {
      statusEl.className = "error";
      statusEl.textContent = "Failed to remove key";
    }
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") activateBtn.click();
    if (e.key === "Escape") closeModal();
  });
}

function updateLicenseButton(plan) {
  const btn = document.getElementById("btn-license");
  if (!btn) return;
  btn.textContent = (plan === "pro" || plan === "pro_trial") ? "LICENSED" : "LICENSE";
}

function setupProjectModal() {
  const openBtn = document.getElementById("btn-change-project");
  const modal = document.getElementById("project-modal");
  const loadBtn = document.getElementById("btn-project-load");
  const cancelBtn = document.getElementById("btn-project-cancel");
  const upBtn = document.getElementById("btn-browse-up");

  if (!openBtn || !modal) return;

  openBtn.addEventListener("click", async function() {
    modal.classList.remove("hidden");
    // Start from current project's parent dir
    try {
      const res = await fetch("/api/project-info");
      const info = await res.json();
      const startPath = info.projectRoot.replace(/[/\\][^/\\]+$/, "");
      browseDir(startPath);
    } catch (_) {
      browseDir(null);
    }
  });

  if (cancelBtn) {
    cancelBtn.addEventListener("click", function() { modal.classList.add("hidden"); });
  }

  if (upBtn) {
    upBtn.addEventListener("click", function() {
      if (browsePath) {
        const parent = browsePath.replace(/[/\\][^/\\]+$/, "");
        if (parent && parent !== browsePath) browseDir(parent);
      }
    });
  }

  if (loadBtn) {
    loadBtn.addEventListener("click", function() {
      if (browsePath) switchProject(browsePath);
    });
  }

  document.addEventListener("keydown", function(e) {
    if (e.key === "Escape" && !modal.classList.contains("hidden")) {
      modal.classList.add("hidden");
    }
  });

  modal.addEventListener("click", function(e) {
    if (e.target === modal) modal.classList.add("hidden");
  });
}

// ══════════════════════════════════════════════════════════════
// AI KEYS MODAL
// ══════════════════════════════════════════════════════════════
function setupAIKeysModal() {
  const btn = document.getElementById("btn-ai-keys");
  const modal = document.getElementById("ai-keys-modal");
  const closeBtn = document.getElementById("btn-ai-keys-close");
  const activeEl = document.getElementById("ai-keys-active");
  if (!btn || !modal) return;

  function updateStatus(row, isConfigured, isActive) {
    const statusEl = row.querySelector(".ai-key-status");
    const removeBtn = row.querySelector(".ai-key-remove-btn");
    if (isActive) {
      statusEl.textContent = "ACTIVE";
      statusEl.className = "ai-key-status active";
    } else if (isConfigured) {
      statusEl.textContent = "CONFIGURED";
      statusEl.className = "ai-key-status configured";
    } else {
      statusEl.textContent = "---";
      statusEl.className = "ai-key-status none";
    }
    if (removeBtn) {
      if (isConfigured || isActive) {
        removeBtn.classList.remove("hidden");
      } else {
        removeBtn.classList.add("hidden");
      }
    }
  }

  function updateAll(aiKeys, activeProvider) {
    const rows = modal.querySelectorAll(".ai-key-row");
    rows.forEach(function(row) {
      const provider = row.dataset.provider;
      const configured = aiKeys[provider] || false;
      const isActive = configured && activeProvider.toLowerCase().includes(provider);
      updateStatus(row, configured, isActive);
    });
    if (activeProvider && activeProvider !== "disabled") {
      activeEl.textContent = "Active: " + activeProvider;
    } else {
      activeEl.textContent = "No AI provider configured";
      activeEl.style.color = "var(--text-secondary)";
    }
  }

  async function openModal() {
    modal.classList.remove("hidden");
    // Clear inputs
    modal.querySelectorAll(".ai-key-input").forEach(function(inp) { inp.value = ""; });
    // Fetch current state
    try {
      const res = await fetch("/api/project-info");
      const info = await res.json();
      updateAll(info.aiKeys || {}, info.aiProvider || "disabled");
    } catch {
      activeEl.textContent = "Failed to fetch status";
    }
  }

  function closeModal() {
    modal.classList.add("hidden");
  }

  btn.addEventListener("click", openModal);
  closeBtn.addEventListener("click", closeModal);
  modal.addEventListener("click", function(e) { if (e.target === modal) closeModal(); });

  // SET button handlers
  modal.querySelectorAll(".ai-key-row").forEach(function(row) {
    const setBtn = row.querySelector(".ai-key-set-btn");
    const input = row.querySelector(".ai-key-input");
    const provider = row.dataset.provider;

    setBtn.addEventListener("click", async function() {
      const key = input.value.trim();
      setBtn.disabled = true;
      setBtn.textContent = "...";

      try {
        const res = await fetch("/api/set-ai-key", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ provider: provider, key: key || null }),
        });
        const data = await res.json();
        if (data.success) {
          updateAll(data.configured, data.activeProvider);
          input.value = "";
          if (key) {
            input.placeholder = "****" + key.slice(-4);
          } else {
            var placeholders = { gemini: "AIzaSy...", openai: "sk-...", anthropic: "sk-ant-..." };
            input.placeholder = placeholders[provider] || "";
          }
          // Refresh provider selector to update enabled/disabled options
          if (window._refreshAIProviderSelector) window._refreshAIProviderSelector();
        }
      } catch (err) {
        var statusEl = row.querySelector(".ai-key-status");
        statusEl.textContent = "ERROR";
        statusEl.className = "ai-key-status";
        statusEl.style.color = "#ff5f57";
      }
      setBtn.disabled = false;
      setBtn.textContent = "SET";
    });

    input.addEventListener("keydown", function(e) {
      if (e.key === "Enter") setBtn.click();
    });

    // REMOVE button handler
    const removeBtn = row.querySelector(".ai-key-remove-btn");
    if (removeBtn) {
      removeBtn.addEventListener("click", async function() {
        removeBtn.disabled = true;
        removeBtn.textContent = "...";

        try {
          const res = await fetch("/api/set-ai-key", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ provider: provider, key: null }),
          });
          const data = await res.json();
          if (data.success) {
            updateAll(data.configured, data.activeProvider);
            input.value = "";
            var placeholders = { gemini: "AIzaSy...", openai: "sk-...", anthropic: "sk-ant-..." };
            input.placeholder = placeholders[provider] || "";
            if (window._refreshAIProviderSelector) window._refreshAIProviderSelector();
          }
        } catch (err) {
          var statusEl = row.querySelector(".ai-key-status");
          statusEl.textContent = "ERROR";
          statusEl.className = "ai-key-status";
          statusEl.style.color = "#ff5f57";
        }
        removeBtn.disabled = false;
        removeBtn.textContent = "REMOVE";
      });
    }
  });

  document.addEventListener("keydown", function(e) {
    if (e.key === "Escape" && !modal.classList.contains("hidden")) {
      closeModal();
    }
  });
}

// ══════════════════════════════════════════════════════════════
// AI PROVIDER SELECTOR
// ══════════════════════════════════════════════════════════════
function setupAIProviderSelector() {
  const select = document.getElementById("ai-provider-select");
  const applyBtn = document.getElementById("btn-ai-apply");
  if (!select || !applyBtn) return;

  // Refresh selector state from project-info
  async function refreshSelector() {
    try {
      const res = await fetch("/api/project-info");
      const info = await res.json();
      updateSelectorState(info.aiKeys || {}, info.aiProviderForced || null);
    } catch {}
  }

  function updateSelectorState(aiKeys, forced) {
    // Enable/disable options based on configured keys
    var options = select.querySelectorAll("option");
    options.forEach(function(opt) {
      if (opt.value === "auto") {
        opt.disabled = false;
        return;
      }
      var hasKey = aiKeys[opt.value] || false;
      opt.disabled = !hasKey;
    });

    // Set selected value
    if (forced && ["gemini", "openai", "anthropic"].includes(forced)) {
      select.value = forced;
    } else {
      select.value = "auto";
    }
  }

  // APPLY button handler
  applyBtn.addEventListener("click", async function() {
    var provider = select.value;
    applyBtn.disabled = true;
    applyBtn.textContent = "...";

    try {
      var res = await fetch("/api/set-ai-provider", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: provider }),
      });
      var data = await res.json();
      if (data.success) {
        applyBtn.textContent = "OK";
        applyBtn.classList.add("success");
        setTimeout(function() {
          applyBtn.textContent = "APPLY";
          applyBtn.classList.remove("success");
        }, 1500);
        // Refresh AI keys modal active display if visible
        var activeEl = document.getElementById("ai-keys-active");
        if (activeEl && data.activeProvider) {
          if (data.activeProvider !== "disabled") {
            activeEl.textContent = "Active: " + data.activeProvider;
            activeEl.style.color = "";
          } else {
            activeEl.textContent = "No AI provider configured";
            activeEl.style.color = "var(--text-secondary)";
          }
        }
      } else {
        applyBtn.textContent = "FAIL";
        setTimeout(function() { applyBtn.textContent = "APPLY"; }, 1500);
      }
    } catch {
      applyBtn.textContent = "ERR";
      setTimeout(function() { applyBtn.textContent = "APPLY"; }, 1500);
    }
    applyBtn.disabled = false;
  });

  // Load initial state
  refreshSelector();

  // Expose refresh for AI Keys modal to call after key changes
  window._refreshAIProviderSelector = refreshSelector;
}
