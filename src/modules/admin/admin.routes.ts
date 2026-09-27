import { Router } from 'express';
import { authenticate, authorize } from '../../middlewares/auth.middleware.js';
import { sendSuccess } from '../../utils/apiResponse.js';

const router = Router();

// Every admin route requires a logged-in user with the 'admin' role.
router.use(authenticate, authorize('admin'));

// TODO: replace with real Drizzle-backed product/order admin controllers
// once catalog and order data are seeded.

router.post('/products', (req, res) => {
  sendSuccess(res, { message: 'Product created (dummy)', product: req.body }, 201);
});

router.patch('/products/:id', (req, res) => {
  sendSuccess(res, { message: `Product ${req.params.id} updated (dummy)`, changes: req.body });
});

router.get('/orders', (_req, res) => {
  sendSuccess(res, [{ id: 101, status: 'pending', userId: 5 }]);
});

router.patch('/orders/:id/status', (req, res) => {
  sendSuccess(res, { message: `Order ${req.params.id} status updated (dummy)`, changes: req.body });
});

export default router;
