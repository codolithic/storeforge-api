import { seedCategories } from './seed-categories.js';
import { seedProducts } from './seed-products.js';
import { seedProductImages } from './seed-product-images.js';
import { seedProductVariants } from './seed-product-variants.js';
import { seedUsers } from './seed-users.js';
import { seedAddresses } from './seed-addresses.js';

try {
  await seedCategories();
  await seedProducts();
  await seedProductImages();
  await seedProductVariants();
  await seedUsers();
  await seedAddresses();
} catch (err: unknown) {
  if (err instanceof Error) {
    console.error('❌ Seeding Failed', err.message);
  } else {
    console.error('❌ Seeding Failed');
  }
}
