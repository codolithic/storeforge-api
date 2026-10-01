import { Menu } from './categories.types.js';
import { db, Category } from '../../db/index.js';

export function arrangeCategories(categories: Category[]) {
  const rootCategories = categories.filter((c) => c.parentId === null);
  const menu: Menu[] = [];

  for (const category of rootCategories) {
    const childCategories = categories.filter((c) => c.parentId === category.id);
    menu.push({
      id: category.id,
      name: category.name,
      slug: category.slug,
      subMenu: childCategories.map((c) => ({
        id: c.id,
        name: c.name,
        slug: c.slug,
        subMenu: null,
      })),
    });
  }

  return menu;
}

export async function listCategories() {
  const categories: Category[] = await db.query.categories.findMany();
  const menu = arrangeCategories(categories);
  return menu;
}
