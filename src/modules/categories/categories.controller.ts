import type { Request, Response } from 'express';
import { sendSuccess } from '../../utils/apiResponse.js';
import { db, Category } from '../../db/index.js';

type Menu = {
  id: number;
  name: string;
  slug: string;
  subMenu: Menu[] | null;
};

function arrangeCategories(categories: Category[]) {
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

export async function listCategories(_req: Request, res: Response): Promise<void> {
  const categories: Category[] = await db.query.categories.findMany();
  const menu = arrangeCategories(categories);
  sendSuccess(res, menu);
}
