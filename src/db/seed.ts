import { seedCategories } from "./seed-categories.js";
import { seedProducts } from "./seed-products.js";

const inputs = process.argv.slice(2);
const tables = inputs.map((i) => i.toLowerCase());

if (tables.includes("categories")) {
  await seedCategories();
}

if (tables.includes("products")) {
  await seedProducts();
}
