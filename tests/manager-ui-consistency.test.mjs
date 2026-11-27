import test, { describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

function read(rel) {
  return fs.readFileSync(path.resolve(process.cwd(), rel), "utf8");
}

describe("BONO Phase 4-B9 — Manager UI/UX Consistency & Shared Controls", () => {
  const managerReports = read("app/manager/reports/page.js");
  const roomsUI = read("app/components/hotel/RoomsUI.jsx");
  const roomReportsUI = read("app/components/hotel/RoomReportsUI.jsx");
  const roomReportsPanel = read("app/components/hotel/RoomReportsPanel.jsx");
  const menuCrudClient = read("app/manager/menu-crud/MenuCrudClient.jsx");
  const inventoryUI = read("app/components/InventoryUI.jsx");
  const staffManagement = read("app/components/StaffManagement.jsx");
  const managerSidebar = read("app/components/ManagerSidebar.jsx");
  const managerTopControls = read("app/components/ManagerTopControls.jsx");

  test("ManagerSidebar is unified across all manager surfaces", () => {
    assert.ok(
      managerReports.includes("<ManagerSidebar"),
      "/manager/reports must render ManagerSidebar"
    );
    assert.ok(
      roomsUI.includes("<ManagerSidebar"),
      "RoomsUI must render ManagerSidebar"
    );
    assert.ok(
      roomReportsUI.includes("<ManagerSidebar"),
      "RoomReportsUI must render ManagerSidebar"
    );

    // Old HotelTopBar must not be present in RoomsUI or RoomReportsUI
    assert.ok(
      !roomsUI.includes("HotelTopBar"),
      "RoomsUI must not render HotelTopBar"
    );
    assert.ok(
      !roomReportsUI.includes("HotelTopBar"),
      "RoomReportsUI must not render HotelTopBar"
    );
  });

  test("ManagerTopControls is unified across Manager Reports, Rooms, Room Reports, Menu, Inventory, and Staff", () => {
    const managerViews = [
      { name: "Manager Reports", src: managerReports },
      { name: "RoomsUI", src: roomsUI },
      { name: "RoomReportsUI", src: roomReportsUI },
      { name: "MenuCrudClient", src: menuCrudClient },
      { name: "InventoryUI", src: inventoryUI },
      { name: "StaffManagement", src: staffManagement },
    ];

    for (const view of managerViews) {
      assert.ok(
        view.src.includes("<ManagerTopControls"),
        `${view.name} must render ManagerTopControls`
      );
      assert.ok(
        !view.src.includes("<LanguageToggle"),
        `${view.name} must not have independent LanguageToggle`
      );
      assert.ok(
        !view.src.includes("<ThemeToggleHome"),
        `${view.name} must not have independent ThemeToggleHome`
      );
    }

    // ManagerTopControls composition and order: Language, Home, Theme
    assert.ok(
      managerTopControls.includes("LanguageToggle"),
      "ManagerTopControls must include LanguageToggle"
    );
    assert.ok(
      managerTopControls.includes('href={homeHref}') || managerTopControls.includes('href="/"'),
      "ManagerTopControls must include Home link"
    );
    assert.ok(
      managerTopControls.includes("ThemeToggleHome"),
      "ManagerTopControls must include ThemeToggleHome"
    );
  });

  test("ManagerSidebar full accent-color styling and glass-effect active state", () => {
    // Light mode full yellow accent (#FFD600)
    assert.ok(
      managerSidebar.includes("bg-[#FFD600]"),
      "sidebar container must use light mode yellow accent bg-[#FFD600]"
    );
    // Dark mode full orange accent (#FF5E00)
    assert.ok(
      managerSidebar.includes("dark:bg-[#FF5E00]"),
      "sidebar container must use dark mode orange accent dark:bg-[#FF5E00]"
    );

    // Glass-effect active state with backdrop blur and border indicator
    assert.ok(
      managerSidebar.includes("backdrop-blur-md"),
      "active item must feature backdrop-blur-md glass styling"
    );
    assert.ok(
      managerSidebar.includes("bg-white/40") && managerSidebar.includes("dark:bg-black/25"),
      "active item must use translucent glass surfaces in light and dark mode"
    );
    assert.ok(
      managerSidebar.includes("border-l-white"),
      "active item must have distinct border indicator"
    );

    // Inactive hover states
    assert.ok(
      managerSidebar.includes("hover:bg-[#FACC15]"),
      "light mode hover must use yellow tint #FACC15"
    );
    assert.ok(
      managerSidebar.includes("dark:hover:bg-[#F97316]"),
      "dark mode hover must use orange tint #F97316"
    );
  });

  test("ManagerSidebar client-side drag-and-drop order persistence", () => {
    assert.ok(
      managerSidebar.includes("bono_manager_sidebar_order"),
      "sidebar must use bono_manager_sidebar_order localStorage key"
    );
    assert.ok(
      managerSidebar.includes("reconcileOrder"),
      "sidebar must reconcile stored order with RAW_ENTRIES"
    );
  });

  test("ManagerSidebar export buttons behavior & RoomsUI disabled state", () => {
    assert.ok(
      managerSidebar.includes("Export available on Reports pages"),
      "disabled export buttons must display tooltip"
    );
    assert.ok(
      managerSidebar.includes("cursor-not-allowed"),
      "disabled export buttons must visually indicate disabled status"
    );
    // RoomsUI passes no callbacks
    assert.ok(
      roomsUI.includes("<ManagerSidebar />") || roomsUI.includes("<ManagerSidebar/>"),
      "RoomsUI passes no export callbacks to keep them safely disabled"
    );
  });

  test("RoomReportsUI and RoomReportsPanel export delegation", () => {
    // Duplicate in-page buttons removed from RoomReportsPanel
    assert.ok(
      !roomReportsPanel.includes("reports.exportCsvLabel"),
      "in-page CSV export button removed from RoomReportsPanel"
    );
    assert.ok(
      !roomReportsPanel.includes("reports.downloadPdfLabel"),
      "in-page PDF export button removed from RoomReportsPanel"
    );

    // RoomReportsPanel provides export callbacks to RoomReportsUI
    assert.ok(
      roomReportsPanel.includes("onExportReady"),
      "RoomReportsPanel accepts onExportReady callback"
    );
    assert.ok(
      roomReportsUI.includes("onExportCsv={exportHandlers?.ready ? exportHandlers.exportCsv : null}"),
      "RoomReportsUI wires onExportCsv to ManagerSidebar"
    );
    assert.ok(
      roomReportsUI.includes("onExportPdf={exportHandlers?.ready ? exportHandlers.exportPdf : null}"),
      "RoomReportsUI wires onExportPdf to ManagerSidebar"
    );
  });

  test("No violations of critical protected file or security boundaries", () => {
    for (const fileContent of [
      managerReports,
      managerSidebar,
      managerTopControls,
      roomsUI,
      roomReportsUI,
      roomReportsPanel,
      menuCrudClient,
      inventoryUI,
      staffManagement,
    ]) {
      assert.ok(
        !fileContent.includes("lib/hotel/db/connection"),
        "must never reference lib/hotel/db/connection"
      );
    }
  });
});
