import { and, asc, desc, eq, gte, like, lte, SQL, sql } from 'drizzle-orm';
import { db } from '../../db/client';
import { products } from '../../db/schema';
import { newId, nowIso } from '../../utils/id';
import { nairaToKobo } from '../../utils/money';
import { NotFoundError } from '../../utils/errors';
import { CreateProductInput, ListProductsQuery, UpdateProductInput } from './products.schema';
import { serializeProduct } from './products.serializer';

export function listProducts(query: ListProductsQuery) {
  const conditions: SQL[] = [];

  if (query.search) {
    const term = `%${query.search.toLowerCase()}%`;
    conditions.push(
      sql`(lower(${products.name}) LIKE ${term} OR lower(${products.description}) LIKE ${term})`,
    );
  }
  if (query.category) conditions.push(eq(products.category, query.category));
  if (query.minPrice !== undefined) conditions.push(gte(products.priceKobo, nairaToKobo(query.minPrice)));
  if (query.maxPrice !== undefined) conditions.push(lte(products.priceKobo, nairaToKobo(query.maxPrice)));
  if (query.inStock === true) conditions.push(sql`${products.stock} > 0`);
  if (query.inStock === false) conditions.push(sql`${products.stock} <= 0`);
  // Public catalog browsing never shows deactivated products. Admin CRUD
  // endpoints (getProductByIdAdmin) bypass this so admins can still manage
  // deactivated stock.
  conditions.push(eq(products.isActive, true));

  const where = conditions.length ? and(...conditions) : undefined;

  const sortColumn =
    query.sortBy === 'price' ? products.priceKobo : query.sortBy === 'name' ? products.name : products.createdAt;
  const orderFn = query.sortOrder === 'asc' ? asc : desc;

  const offset = (query.page - 1) * query.pageSize;

  const rows = db
    .select()
    .from(products)
    .where(where)
    .orderBy(orderFn(sortColumn))
    .limit(query.pageSize)
    .offset(offset)
    .all();

  const totalRow = db
    .select({ count: sql<number>`count(*)` })
    .from(products)
    .where(where)
    .get();
  const total = totalRow?.count ?? 0;

  return {
    data: rows.map(serializeProduct),
    pagination: {
      page: query.page,
      pageSize: query.pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
    },
  };
}

export function getProductById(id: string, opts: { includeInactive?: boolean } = {}) {
  const row = db.select().from(products).where(eq(products.id, id)).get();
  if (!row) throw new NotFoundError('Product not found');
  if (!opts.includeInactive && !row.isActive) throw new NotFoundError('Product not found');
  return serializeProduct(row);
}

/** Distinct category list, for building filter UIs. */
export function listCategories() {
  const rows = db
    .selectDistinct({ category: products.category })
    .from(products)
    .where(eq(products.isActive, true))
    .all();
  return rows.map((r) => r.category).sort();
}

export function createProduct(input: CreateProductInput) {
  const now = nowIso();
  const id = newId();
  db.insert(products)
    .values({
      id,
      name: input.name,
      description: input.description,
      category: input.category,
      priceKobo: nairaToKobo(input.priceNaira),
      stock: input.stock,
      isActive: input.isActive ?? true,
      imageUrl: input.imageUrl,
      version: 0,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  return getProductById(id, { includeInactive: true });
}

export function updateProduct(id: string, input: UpdateProductInput) {
  const existing = db.select().from(products).where(eq(products.id, id)).get();
  if (!existing) throw new NotFoundError('Product not found');

  db.update(products)
    .set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.category !== undefined ? { category: input.category } : {}),
      ...(input.priceNaira !== undefined ? { priceKobo: nairaToKobo(input.priceNaira) } : {}),
      ...(input.stock !== undefined ? { stock: input.stock } : {}),
      ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      ...(input.imageUrl !== undefined ? { imageUrl: input.imageUrl } : {}),
      version: existing.version + 1,
      updatedAt: nowIso(),
    })
    .where(eq(products.id, id))
    .run();

  return getProductById(id, { includeInactive: true });
}

/** Admin "delete" is a soft delete (isActive=false) to preserve order history integrity. */
export function deactivateProduct(id: string) {
  const existing = db.select().from(products).where(eq(products.id, id)).get();
  if (!existing) throw new NotFoundError('Product not found');
  db.update(products)
    .set({ isActive: false, version: existing.version + 1, updatedAt: nowIso() })
    .where(eq(products.id, id))
    .run();
  return { id, isActive: false };
}
