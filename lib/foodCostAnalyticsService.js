// foodCostAnalyticsService.js — Phase H6.1 Food Cost Analytics Service + API Only
// Read-only, historical snapshot cost only, never InventoryItem.cost fallback
// Uses StockMovement totalCost snapshot from H2, no writes.

import { getStockMovementModel } from "@/lib/models/StockMovement";

/**
 * Food cost summary: sum totalCost where type OUT reason SaleDeduction totalCost != null
 * @param {import("mongoose").Connection} conn
 * @param {{from:Date|null,to:Date|null}} range
 * @returns {Promise<{foodCost:number}>}
 */
export async function getFoodCostSummary(conn, { from, to }) {
  const StockMovement = getStockMovementModel(conn);
  const match = { type: "OUT", reason: "SaleDeduction", totalCost: { $ne: null } };
  if (from || to) {
    match.createdAt = {};
    if (from) match.createdAt.$gte = from;
    if (to) match.createdAt.$lt = to;
  }
  const pipeline = [
    { $match: match },
    { $group: { _id: null, foodCost: { $sum: "$totalCost" } } },
  ];
  const [doc] = await StockMovement.aggregate(pipeline);
  return { foodCost: Math.round((Number(doc?.foodCost) || 0) * 100) / 100 };
}

/**
 * Daily food cost trend: aggregate per YYYY-MM-DD
 * @param {import("mongoose").Connection} conn
 * @param {{from:Date|null,to:Date|null}} range
 * @returns {Promise<Array<{date:string, foodCost:number}>>}
 */
export async function getFoodCostTrend(conn, { from, to }) {
  const StockMovement = getStockMovementModel(conn);
  const match = { type: "OUT", reason: "SaleDeduction", totalCost: { $ne: null } };
  if (from || to) {
    match.createdAt = {};
    if (from) match.createdAt.$gte = from;
    if (to) match.createdAt.$lt = to;
  }
  const pipeline = [
    { $match: match },
    {
      $group: {
        _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt", timezone: "Africa/Addis_Ababa" } },
        foodCost: { $sum: "$totalCost" },
      },
    },
    { $sort: { _id: 1 } },
    {
      $project: {
        _id: 0,
        date: "$_id",
        foodCost: 1,
      },
    },
  ];
  const docs = await StockMovement.aggregate(pipeline);
  return docs.map((d) => ({
    date: String(d.date),
    foodCost: Math.round((Number(d.foodCost) || 0) * 100) / 100,
  }));
}

/**
 * Top cost ingredients: group by item sum totalCost + quantity, lookup after group
 * @param {import("mongoose").Connection} conn
 * @param {{from:Date|null,to:Date|null}} range
 * @returns {Promise<Array<{itemId:string, name:string, quantity:number, unit:string, cost:number}>>}
 */
export async function getTopCostIngredients(conn, { from, to }) {
  const StockMovement = getStockMovementModel(conn);
  const match = { type: "OUT", reason: "SaleDeduction", totalCost: { $ne: null } };
  if (from || to) {
    match.createdAt = {};
    if (from) match.createdAt.$gte = from;
    if (to) match.createdAt.$lt = to;
  }
  const pipeline = [
    { $match: match },
    {
      $group: {
        _id: "$item",
        totalCost: { $sum: "$totalCost" },
        quantity: { $sum: "$quantity" },
      },
    },
    { $sort: { totalCost: -1 } },
    { $limit: 10 },
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
        itemId: { $toString: "$_id" },
        name: { $ifNull: ["$inv.name", "Unknown"] },
        unit: { $ifNull: ["$inv.unit", ""] },
        quantity: 1,
        cost: "$totalCost",
      },
    },
  ];
  const docs = await StockMovement.aggregate(pipeline);
  return docs.map((d) => ({
    itemId: String(d.itemId),
    name: String(d.name || ""),
    quantity: Number(d.quantity) || 0,
    unit: String(d.unit || ""),
    cost: Math.round((Number(d.cost) || 0) * 100) / 100,
  }));
}
