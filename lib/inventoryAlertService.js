// inventoryAlertService.js — Phase H3 Low Stock Intelligence foundation
// Pure read-only service, no writes, no mutation.
// Uses database-side filtering via $expr, lean output, serializable response.
//
// Sellability is `availableStock = currentStock - reservedStock`: stock held by
// live orders is not available to sell, so low/out-of-stock alerts must use the
// available quantity, never physical currentStock alone.

import { getInventoryItemModel } from "@/lib/models/InventoryItem";

const AVAILABLE_STOCK_EXPR = {
  $subtract: [
    { $ifNull: ["$currentStock", 0] },
    { $ifNull: ["$reservedStock", 0] },
  ],
};

/**
 * Get low-stock items: availableStock <= minimumStock
 * Includes out-of-stock when minimumStock >=0, but returns shortage for each.
 * Uses aggregation $match with $expr for DB-side filtering.
 * @param {import("mongoose").Connection} conn
 * @returns {Promise<Array<{itemId:string,name:string,category:string,currentStock:number,reservedStock:number,availableStock:number,minimumStock:number,unit:string,status:string,shortage:number}>>}
 */
export async function getLowStockItems(conn) {
  const InventoryItem = getInventoryItemModel(conn);
  const pipeline = [
    { $addFields: { availableStock: AVAILABLE_STOCK_EXPR } },
    {
      $match: {
        $expr: { $lte: ["$availableStock", "$minimumStock"] },
      },
    },
    { $sort: { availableStock: 1, name: 1 } },
    {
      $project: {
        itemId: { $toString: "$_id" },
        name: 1,
        category: 1,
        currentStock: 1,
        reservedStock: { $ifNull: ["$reservedStock", 0] },
        availableStock: 1,
        minimumStock: 1,
        unit: 1,
        status: 1,
        shortage: { $subtract: ["$minimumStock", "$availableStock"] },
      },
    },
  ];
  const docs = await InventoryItem.aggregate(pipeline);
  return docs.map((d) => ({
    itemId: String(d.itemId || d._id),
    name: String(d.name || ""),
    category: String(d.category || ""),
    currentStock: Number(d.currentStock) || 0,
    reservedStock: Number(d.reservedStock) || 0,
    availableStock: Number(d.availableStock) || 0,
    minimumStock: Number(d.minimumStock) || 0,
    unit: String(d.unit || ""),
    status: String(d.status || ""),
    shortage: Number(d.shortage) || 0,
  }));
}

/**
 * Get inventory alerts separated into lowStock (0 < availableStock <= minimumStock)
 * and outOfStock (availableStock <= 0). Uses availableStock as source of truth,
 * not stored status or physical currentStock.
 * @param {import("mongoose").Connection} conn
 * @returns {Promise<{lowStock:Array, outOfStock:Array}>}
 */
export async function getInventoryAlerts(conn) {
  const InventoryItem = getInventoryItemModel(conn);

  const project = {
    itemId: { $toString: "$_id" },
    name: 1,
    category: 1,
    currentStock: 1,
    reservedStock: { $ifNull: ["$reservedStock", 0] },
    availableStock: 1,
    minimumStock: 1,
    unit: 1,
    status: 1,
    shortage: { $subtract: ["$minimumStock", "$availableStock"] },
  };

  const outOfStockPipeline = [
    { $addFields: { availableStock: AVAILABLE_STOCK_EXPR } },
    { $match: { availableStock: { $lte: 0 } } },
    { $sort: { availableStock: 1, name: 1 } },
    { $project: project },
  ];

  const lowStockPipeline = [
    { $addFields: { availableStock: AVAILABLE_STOCK_EXPR } },
    {
      $match: {
        $expr: {
          $and: [
            { $gt: ["$availableStock", 0] },
            { $lte: ["$availableStock", "$minimumStock"] },
          ],
        },
      },
    },
    { $sort: { availableStock: 1, name: 1 } },
    { $project: project },
  ];

  const [outOfStock, lowStock] = await Promise.all([
    InventoryItem.aggregate(outOfStockPipeline),
    InventoryItem.aggregate(lowStockPipeline),
  ]);

  const mapDoc = (d) => ({
    itemId: String(d.itemId || d._id),
    name: String(d.name || ""),
    category: String(d.category || ""),
    currentStock: Number(d.currentStock) || 0,
    reservedStock: Number(d.reservedStock) || 0,
    availableStock: Number(d.availableStock) || 0,
    minimumStock: Number(d.minimumStock) || 0,
    unit: String(d.unit || ""),
    status: String(d.status || ""),
    shortage: Number(d.shortage) || 0,
  });

  return {
    lowStock: lowStock.map(mapDoc),
    outOfStock: outOfStock.map(mapDoc),
  };
}
