import 'dotenv/config';
import { db, sqlite } from './client';
import { users, carts, products } from './schema';
import { hashPassword } from '../utils/password';
import { newId, nowIso } from '../utils/id';
import { nairaToKobo } from '../utils/money';
import { env } from '../config/env';
import { eq } from 'drizzle-orm';

async function seed() {
  const now = nowIso();

  // --- Admin ---
  const existingAdmin = db.select().from(users).where(eq(users.email, env.ADMIN_SEED_EMAIL)).get();
  if (!existingAdmin) {
    const adminId = newId();
    db.insert(users)
      .values({
        id: adminId,
        name: 'GDGoC Admin',
        email: env.ADMIN_SEED_EMAIL,
        passwordHash: await hashPassword(env.ADMIN_SEED_PASSWORD),
        role: 'ADMIN',
        createdAt: now,
        updatedAt: now,
      })
      .run();
    db.insert(carts).values({ id: newId(), userId: adminId, createdAt: now, updatedAt: now }).run();
    console.log(`Seeded admin: ${env.ADMIN_SEED_EMAIL} / ${env.ADMIN_SEED_PASSWORD}`);
  }

  // --- Demo customer ---
  const demoEmail = 'customer@gdgoc.dev';
  const existingCustomer = db.select().from(users).where(eq(users.email, demoEmail)).get();
  if (!existingCustomer) {
    const custId = newId();
    db.insert(users)
      .values({
        id: custId,
        name: 'Demo Customer',
        email: demoEmail,
        passwordHash: await hashPassword('Customer123!'),
        role: 'CUSTOMER',
        createdAt: now,
        updatedAt: now,
      })
      .run();
    db.insert(carts).values({ id: newId(), userId: custId, createdAt: now, updatedAt: now }).run();
    console.log(`Seeded customer: ${demoEmail} / Customer123!`);
  }

  // --- Sample products ---
  const existingProducts = db.select().from(products).all();
  if (existingProducts.length === 0) {
    const sample = [
      { name: 'Wireless Mouse', description: 'Ergonomic 2.4GHz wireless mouse', category: 'Electronics', priceNaira: 8500, stock: 40 },
      { name: 'Mechanical Keyboard', description: 'RGB backlit mechanical keyboard, blue switches', category: 'Electronics', priceNaira: 32000, stock: 15 },
      { name: '20L Backpack', description: 'Water-resistant laptop backpack', category: 'Fashion', priceNaira: 15500, stock: 25 },
      { name: 'Stainless Steel Bottle', description: '1L insulated water bottle', category: 'Home', priceNaira: 6200, stock: 60 },
      { name: 'Bluetooth Speaker', description: 'Portable speaker, 12hr battery', category: 'Electronics', priceNaira: 21000, stock: 2 },
      { name: 'Desk Lamp', description: 'LED desk lamp with 3 brightness modes', category: 'Home', priceNaira: 9800, stock: 30 },
      { name: 'Notebook Set (3-Pack)', description: 'A5 dotted notebooks', category: 'Stationery', priceNaira: 4200, stock: 100 },
      { name: 'Running Shoes', description: 'Lightweight breathable running shoes', category: 'Fashion', priceNaira: 27500, stock: 18 },
      { name: 'Phone Stand', description: 'Adjustable aluminum phone stand', category: 'Electronics', priceNaira: 3500, stock: 0 },
      { name: 'Coffee Mug', description: 'Ceramic 350ml mug', category: 'Home', priceNaira: 2800, stock: 75 },
    ];
    for (const p of sample) {
      db.insert(products)
        .values({
          id: newId(),
          name: p.name,
          description: p.description,
          category: p.category,
          priceKobo: nairaToKobo(p.priceNaira),
          stock: p.stock,
          isActive: true,
          version: 0,
          createdAt: now,
          updatedAt: now,
        })
        .run();
    }
    console.log(`Seeded ${sample.length} sample products.`);
  }

  sqlite.close();
  console.log('Seeding complete.');
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
