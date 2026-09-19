// inventoryAlertService.js — Phase H3 Low Stock Intelligence foundation
// Pure read-only service, no writes, no mutation.
// Uses database-side filtering via $expr, lean output, serializable response.

import { getInventoryItemModel } from "@/lib/models/InventoryItem";

/**
 * Get low-stock items: currentStock <= minimumStock
 * Includes out-of-stock when minimumStock >=0, but returns shortage for each.
 * Uses aggregation $match with $expr for DB-side filtering.
 * @param {import("mongoose").Connection} conn
 * @returns {Promise<Array<{itemId:string,name:string,category:string,currentStock:number,minimumStock:number,unit:string,status:string,shortage:number}>>}
 */
export async function getLowStockItems(conn) {
  const InventoryItem = getInventoryItemModel(conn);
  const pipeline = [
    {
      $match: {
        $expr: { $lte: ["$currentStock", "$minimumStock"] },
      },
    },
    { $sort: { currentStock: 1, name: 1 } },
    {
      $project: {
        itemId: { $toString: "$_id" },
        name: 1,
        category: 1,
        currentStock: 1,
        minimumStock: 1,
        unit: 1,
        status: 1,
        shortage: { $subtract: ["$minimumStock", "$currentStock"] },
      },
    },
  ];
  const docs = await InventoryItem.aggregate(pipeline);
  return docs.map((d) => ({
    itemId: String(d.itemId || d._id),
    name: String(d.name || ""),
    category: String(d.category || ""),
    currentStock: Number(d.currentStock) || 0,
    minimumStock: Number(d.minimumStock) || 0,
    unit: String(d.unit || ""),
    status: String(d.status || ""),
    shortage: Number(d.shortage) || 0,
  }));
}

/**
 * Get inventory alerts separated into lowStock (0 < currentStock <= minimumStock) and outOfStock (currentStock <=0).
 * Uses currentStock as source of truth, not stored status.
 * @param {import("mongoose").Connection} conn
 * @returns {Promise<{lowStock:Array, outOfStock:Array}>}
 */
export async function getInventoryAlerts(conn) {
  const InventoryItem = getInventoryItemModel(conn);

  const outOfStockPipeline = [
    { $match: { currentStock: { $lte: 0 } } },
    { $sort: { currentStock: 1, name: 1 } },
    {
      $project: {
        itemId: { $toString: "$_id" },
        name: 1,
        category: 1,
        currentStock: 1,
        minimumStock: 1,
        unit: 1,
        status: 1,
        shortage: { $subtract: ["$minimumStock", "$currentStock"] },
      },
    },
  ];

  const lowStockPipeline = [
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
    { $sort: { currentStock: 1, name: 1 } },
    {
      $project: {
        itemId: { $toString: "$_id" },
        name: 1,
        category: 1,
        currentStock: 1,
        minimumStock: 1,
        unit: 1,
        status: 1,
        shortage: { $subtract: ["$minimumStock", "$currentStock"] },
      },
    },
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
