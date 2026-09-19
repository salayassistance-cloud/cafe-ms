// Inventory analytics foundation — Phase H1
// Additive, separate from lib/analytics.js + lib/reportService.js
// Uses StockMovement + InventoryItem aggregations, no Order scan, no writes.

import { getStockMovementModel } from "@/lib/models/StockMovement";
import { getInventoryItemModel } from "@/lib/models/InventoryItem";

/**
 * Stock usage: sum OUT SaleDeduction + Waste per inventory item in date range.
 * Uses $match early, $group before $lookup for performance.
 * @param {import("mongoose").Connection} conn
 * @param {{from:Date|null, to:Date|null}} range
 * @returns {Promise<Array<{inventoryItemId:string, name:string, unit:string, quantityUsed:number}>>}
 */
export async function getStockUsage(conn, { from, to }) {
  const StockMovement = getStockMovementModel(conn);
  const match = {
    type: "OUT",
    reason: { $in: ["SaleDeduction", "Waste"] },
  };
  if (from || to) {
    match.createdAt = {};
    if (from) match.createdAt.$gte = from;
    if (to) match.createdAt.$lte = to;
    if (Object.keys(match.createdAt).length === 0) delete match.createdAt;
  }

  const pipeline = [
    { $match: match },
    {
      $group: {
        _id: "$item",
        quantityUsed: { $sum: "$quantity" },
      },
    },
    { $sort: { quantityUsed: -1 } },
    {
      $lookup: {
        from: "inventoryitems",
        localField: "_id",
        foreignField: "_id",
        as: "inv",
      },
    },
    { $unwind: { path: "$inv", preserveNullAndEmptyArrays: true } },
    {
      $project: {
        inventoryItemId: { $toString: "$_id" },
        name: { $ifNull: ["$inv.name", "Unknown"] },
        unit: { $ifNull: ["$inv.unit", ""] },
        quantityUsed: 1,
      },
    },
  ];

  const docs = await StockMovement.aggregate(pipeline);
  // Ensure serializable and empty-safe
  return docs.map((d) => ({
    inventoryItemId: String(d.inventoryItemId),
    name: String(d.name || ""),
    unit: String(d.unit || ""),
    quantityUsed: Number(d.quantityUsed) || 0,
  }));
}

/**
 * Inventory valuation: currentStock * cost per item and total.
 * Uses InventoryItem aggregation.
 * @param {import("mongoose").Connection} conn
 * @returns {Promise<{totalValue:number, items:Array<{itemId:string, name:string, currentStock:number, unit:string, cost:number, value:number}>}>}
 */
export async function getInventoryValuation(conn) {
  const InventoryItem = getInventoryItemModel(conn);

  const pipeline = [
    {
      $project: {
        name: 1,
        currentStock: 1,
        unit: 1,
        cost: 1,
        value: { $multiply: ["$currentStock", "$cost"] },
      },
    },
    { $sort: { name: 1 } },
  ];

  const items = await InventoryItem.aggregate(pipeline);

  const serialized = items.map((d) => ({
    itemId: String(d._id),
    name: String(d.name || ""),
    currentStock: Number(d.currentStock) || 0,
    unit: String(d.unit || ""),
    cost: Number(d.cost) || 0,
    value: Math.round((Number(d.value) || 0) * 100) / 100,
  }));

  const totalValue = Math.round(serialized.reduce((sum, it) => sum + (it.value || 0), 0) * 100) / 100;

  return { totalValue, items: serialized };
}

/**
 * Purchase history: grouped IN Purchase movements in date range.
 * @param {import("mongoose").Connection} conn
 * @param {{from:Date|null, to:Date|null}} range
 * @returns {Promise<Array<{inventoryItemId:string, name:string, unit:string, quantityPurchased:number, count:number}>>}
 */
export async function getPurchaseHistory(conn, { from, to }) {
  const StockMovement = getStockMovementModel(conn);
  const match = {
    type: "IN",
    reason: "Purchase",
  };
  if (from || to) {
    match.createdAt = {};
    if (from) match.createdAt.$gte = from;
    if (to) match.createdAt.$lte = to;
    if (Object.keys(match.createdAt).length === 0) delete match.createdAt;
  }

  const pipeline = [
    { $match: match },
    {
      $group: {
        _id: "$item",
        quantityPurchased: { $sum: "$quantity" },
        count: { $sum: 1 },
      },
    },
    { $sort: { quantityPurchased: -1 } },
    {
      $lookup: {
        from: "inventoryitems",
        localField: "_id",
        foreignField: "_id",
        as: "inv",
      },
    },
    { $unwind: { path: "$inv", preserveNullAndEmptyArrays: true } },
    {
      $project: {
        inventoryItemId: { $toString: "$_id" },
        name: { $ifNull: ["$inv.name", "Unknown"] },
        unit: { $ifNull: ["$inv.unit", ""] },
        quantityPurchased: 1,
        count: 1,
      },
    },
  ];

  const docs = await StockMovement.aggregate(pipeline);
  return docs.map((d) => ({
    inventoryItemId: String(d.inventoryItemId),
    name: String(d.name || ""),
    unit: String(d.unit || ""),
    quantityPurchased: Number(d.quantityPurchased) || 0,
    count: Number(d.count) || 0,
  }));
}
