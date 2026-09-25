import { products } from '../../db/schema';
import { koboToNaira } from '../../utils/money';

export function serializeProduct(p: typeof products.$inferSelect) {
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    category: p.category,
    price: koboToNaira(p.priceKobo),
    stock: p.stock,
    inStock: p.stock > 0,
    isActive: p.isActive,
    imageUrl: p.imageUrl ?? null,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}
