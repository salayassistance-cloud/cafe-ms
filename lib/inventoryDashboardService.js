// inventoryDashboardService.js — Phase H5.1 Dashboard Foundation
// Pure read-only aggregations, serializable JSON, no writes.
// Uses InventoryItem + StockMovement, separate from sales analytics.

import { getInventoryItemModel } from "@/lib/models/InventoryItem";
import { getStockMovementModel } from "@/lib/models/StockMovement";

/**
 * Inventory overview: totalItems, lowStockCount, outOfStockCount, inventoryValue
 * inventoryValue = currentStock * cost via aggregation, no find().lean() loop.
 * @param {import("mongoose").Connection} conn
 * @returns {Promise<{totalItems:number, lowStockCount:number, outOfStockCount:number, inventoryValue:number}>}
 */
export async function getInventoryOverview(conn) {
  const InventoryItem = getInventoryItemModel(conn);
  const pipeline = [
    {
      $facet: {
        stats: [
          {
            $group: {
              _id: null,
              totalItems: { $sum: 1 },
              inventoryValue: { $sum: { $multiply: ["$currentStock", "$cost"] } },
            },
          },
        ],
        lowStock: [
          {
            $match: {
              $expr: {
                $and: [
                  { $gt: ["$currentStock", 0] },
                  { $lte: ["$currentStock", "$minimumStock"] },
                ],
              },
            },
          },
          { $count: "count" },
        ],
        outOfStock: [
          { $match: { currentStock: { $lte: 0 } } },
          { $count: "count" },
        ],
      },
    },
    {
      $project: {
        totalItems: { $ifNull: [{ $arrayElemAt: ["$stats.totalItems", 0] }, 0] },
        inventoryValue: { $ifNull: [{ $arrayElemAt: ["$stats.inventoryValue", 0] }, 0] },
        lowStockCount: { $ifNull: [{ $arrayElemAt: ["$lowStock.count", 0] }, 0] },
        outOfStockCount: { $ifNull: [{ $arrayElemAt: ["$outOfStock.count", 0] }, 0] },
      },
    },
  ];
  const [doc] = await InventoryItem.aggregate(pipeline);
  return {
    totalItems: Number(doc?.totalItems) || 0,
    lowStockCount: Number(doc?.lowStockCount) || 0,
    outOfStockCount: Number(doc?.outOfStockCount) || 0,
    inventoryValue: Math.round((Number(doc?.inventoryValue) || 0) * 100) / 100,
  };
}

/**
 * Consumption summary: OUT SaleDeduction grouped per item
 * $match first, $group before $lookup
 * @param {import("mongoose").Connection} conn
 * @param {{from:Date|null,to:Date|null}} range
 * @returns {Promise<Array<{itemId:string, name:string, unit:string, quantityUsed:number}>>}
 */
export async function getConsumptionSummary(conn, { from, to }) {
  const StockMovement = getStockMovementModel(conn);
  const match = { type: "OUT", reason: "SaleDeduction" };
  if (from || to) {
    match.createdAt = {};
    if (from) match.createdAt.$gte = from;
    if (to) match.createdAt.$lt = to;
  }
  const pipeline = [
    { $match: match },
    { $group: { _id: "$item", quantityUsed: { $sum: "$quantity" } } },
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
        itemId: { $toString: "$_id" },
        name: { $ifNull: ["$inv.name", "Unknown"] },
        unit: { $ifNull: ["$inv.unit", ""] },
        quantityUsed: 1,
      },
    },
  ];
  const docs = await StockMovement.aggregate(pipeline);
  return docs.map((d) => ({
    itemId: String(d.itemId),
    name: String(d.name || ""),
    unit: String(d.unit || ""),
    quantityUsed: Number(d.quantityUsed) || 0,
  }));
}

/**
 * Waste summary: reason Waste, uses totalCost snapshot, handle null safely
 * @param {import("mongoose").Connection} conn
 * @param {{from:Date|null,to:Date|null}} range
 * @returns {Promise<{totalWasteQuantity:number, totalWasteCost:number, items:Array<{itemId:string, name:string, unit:string, quantity:number, cost:number}>}>}
 */
export async function getWasteSummary(conn, { from, to }) {
  const StockMovement = getStockMovementModel(conn);
  const match = { reason: "Waste" };
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
        quantity: { $sum: "$quantity" },
        cost: { $sum: { $ifNull: ["$totalCost", 0] } },
      },
    },
    { $sort: { quantity: -1 } },
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
        cost: 1,
      },
    },
  ];
  const docs = await StockMovement.aggregate(pipeline);
  const items = docs.map((d) => ({
    itemId: String(d.itemId),
    name: String(d.name || ""),
    unit: String(d.unit || ""),
    quantity: Number(d.quantity) || 0,
    cost: Math.round((Number(d.cost) || 0) * 100) / 100,
  }));
  const totalWasteQuantity = items.reduce((s, it) => s + (it.quantity || 0), 0);
  const totalWasteCost = Math.round(items.reduce((s, it) => s + (it.cost || 0), 0) * 100) / 100;
  return { totalWasteQuantity, totalWasteCost, items };
}

/**
 * Food cost summary: SaleDeduction totalCost (historical snapshot), no fallback to InventoryItem.cost
 * @param {import("mongoose").Connection} conn
 * @param {{from:Date|null,to:Date|null}} range
 * @returns {Promise<{foodCost:number}>}
 */
export async function getFoodCostSummary(conn, { from, to }) {
  const StockMovement = getStockMovementModel(conn);
  const match = { reason: "SaleDeduction" };
  if (from || to) {
    match.createdAt = {};
    if (from) match.createdAt.$gte = from;
    if (to) match.createdAt.$lt = to;
  }
  const pipeline = [
    { $match: match },
    {
      $group: {
        _id: null,
        foodCost: { $sum: { $ifNull: ["$totalCost", 0] } },
      },
    },
  ];
  const [doc] = await StockMovement.aggregate(pipeline);
  return { foodCost: Math.round((Number(doc?.foodCost) || 0) * 100) / 100 };
}

/**
 * Top consumed ingredients: top 10 by quantityUsed
 * @param {import("mongoose").Connection} conn
 * @param {{from:Date|null,to:Date|null}} range
 * @returns {Promise<Array<{itemId:string, name:string, unit:string, quantityUsed:number}>>}
 */
export async function getTopConsumedIngredients(conn, { from, to }) {
  const StockMovement = getStockMovementModel(conn);
  const match = { type: "OUT", reason: "SaleDeduction" };
  if (from || to) {
    match.createdAt = {};
    if (from) match.createdAt.$gte = from;
    if (to) match.createdAt.$lt = to;
  }
  const pipeline = [
    { $match: match },
    { $group: { _id: "$item", quantityUsed: { $sum: "$quantity" } } },
    { $sort: { quantityUsed: -1 } },
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
        quantityUsed: 1,
      },
    },
  ];
  const docs = await StockMovement.aggregate(pipeline);
  return docs.map((d) => ({
    itemId: String(d.itemId),
    name: String(d.name || ""),
    unit: String(d.unit || ""),
    quantityUsed: Number(d.quantityUsed) || 0,
  }));
}
