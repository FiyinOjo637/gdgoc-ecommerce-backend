import { app, request, createUser, createProduct, authed } from './helpers';

describe('Products', () => {
  describe('Public browsing', () => {
    it('lists only active products by default', async () => {
      createProduct({ name: 'Active One', isActive: true });
      createProduct({ name: 'Inactive One', isActive: false });
      const res = await request(app).get('/products');
      expect(res.status).toBe(200);
      const names = res.body.data.map((p: any) => p.name);
      expect(names).toContain('Active One');
      expect(names).not.toContain('Inactive One');
    });

    it('searches by name/description substring, case-insensitively', async () => {
      createProduct({ name: 'Mechanical Keyboard' });
      createProduct({ name: 'Wireless Mouse' });
      const res = await request(app).get('/products?search=keyboard');
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].name).toBe('Mechanical Keyboard');
    });

    it('filters by category and price range', async () => {
      createProduct({ name: 'Cheap Shirt', category: 'Fashion', priceNaira: 2000 });
      createProduct({ name: 'Expensive Shirt', category: 'Fashion', priceNaira: 50000 });
      createProduct({ name: 'Cheap Gadget', category: 'Electronics', priceNaira: 2000 });

      const res = await request(app).get('/products?category=Fashion&maxPrice=10000');
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].name).toBe('Cheap Shirt');
    });

    it('filters by stock availability', async () => {
      createProduct({ name: 'In Stock Item', stock: 5 });
      createProduct({ name: 'Out Of Stock Item', stock: 0 });
      const res = await request(app).get('/products?inStock=true');
      const names = res.body.data.map((p: any) => p.name);
      expect(names).toContain('In Stock Item');
      expect(names).not.toContain('Out Of Stock Item');
    });

    it('paginates results', async () => {
      for (let i = 0; i < 5; i++) createProduct({ name: `Item ${i}` });
      const res = await request(app).get('/products?page=1&pageSize=2');
      expect(res.body.data).toHaveLength(2);
      expect(res.body.pagination.total).toBe(5);
      expect(res.body.pagination.totalPages).toBe(3);
    });

    it('returns product detail by id', async () => {
      const id = createProduct({ name: 'Detail Product' });
      const res = await request(app).get(`/products/${id}`);
      expect(res.status).toBe(200);
      expect(res.body.name).toBe('Detail Product');
    });

    it('returns 404 for an inactive product detail (public)', async () => {
      const id = createProduct({ name: 'Hidden Product', isActive: false });
      const res = await request(app).get(`/products/${id}`);
      expect(res.status).toBe(404);
    });
  });

  describe('Admin CRUD + RBAC', () => {
    it('rejects product creation without auth', async () => {
      const res = await request(app).post('/products').send({
        name: 'X', description: 'd', category: 'c', priceNaira: 100, stock: 1,
      });
      expect(res.status).toBe(401);
    });

    it('rejects product creation from a CUSTOMER (403)', async () => {
      const customer = await createUser({ role: 'CUSTOMER' });
      const res = await request(app)
        .post('/products')
        .set(authed(customer.token))
        .send({ name: 'X', description: 'd', category: 'c', priceNaira: 100, stock: 1 });
      expect(res.status).toBe(403);
    });

    it('allows an ADMIN to create, update, and deactivate a product', async () => {
      const admin = await createUser({ role: 'ADMIN' });

      const createRes = await request(app)
        .post('/products')
        .set(authed(admin.token))
        .send({ name: 'New Product', description: 'desc', category: 'cat', priceNaira: 500, stock: 10 });
      expect(createRes.status).toBe(201);
      const id = createRes.body.id;

      const updateRes = await request(app)
        .patch(`/products/${id}`)
        .set(authed(admin.token))
        .send({ priceNaira: 750 });
      expect(updateRes.status).toBe(200);
      expect(updateRes.body.price).toBe(750);

      const deleteRes = await request(app).delete(`/products/${id}`).set(authed(admin.token));
      expect(deleteRes.status).toBe(200);
      expect(deleteRes.body.isActive).toBe(false);

      const publicGet = await request(app).get(`/products/${id}`);
      expect(publicGet.status).toBe(404);
    });
  });
});
