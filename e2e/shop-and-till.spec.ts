import { expect, test, type Page } from '@playwright/test';
import { E2E } from './fixtures';

/**
 * The two ways money comes in, end to end: a shopper buys online with the test card (checkout → gateway → signed
 * webhook → order paid), staff take the order on, and a cashier rings up a sale at the till.
 */

test.describe.configure({ mode: 'serial' });

let orderNumber = '';

async function staffLogin(page: Page) {
  await page.goto(`${E2E.urls.backoffice}/login`);
  await page.getByLabel('Email').fill(E2E.owner.email);
  await page.getByLabel('Password').fill(E2E.owner.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();
}

test('a shopper registers, checks out with the test card, and the order is paid', async ({ page }) => {
  const store = E2E.urls.storefront;
  await page.goto(store);
  await page.getByRole('link', { name: 'Shop now' }).click();
  await page.getByRole('link', { name: new RegExp(E2E.product.name) }).first().click();
  await expect(page.getByRole('heading', { name: E2E.product.name })).toBeVisible();
  await page.getByLabel('Quantity').fill('2');
  await page.getByRole('button', { name: 'Add to cart' }).click();
  await expect(page.getByRole('link', { name: 'Cart, 2 items' })).toBeVisible();

  await page.getByRole('link', { name: 'Cart, 2 items' }).click();
  await expect(page.getByText('₦5,000.00').first()).toBeVisible();
  await page.getByRole('link', { name: 'Checkout' }).click();

  // Not signed in: sign-in page, then create an account and come back to checkout.
  await page.getByRole('link', { name: 'Create an account' }).click();
  await page.getByLabel('Full name').fill('Ada Obi');
  await page.getByLabel('Email').fill(`ada.${Date.now()}@shop.test`);
  await page.getByLabel('Phone').fill('08031112222');
  await page.getByLabel(/^Password/).fill('shopper-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { name: 'Checkout' })).toBeVisible();

  await page.getByRole('radio', { name: /Pick up in store/ }).check();
  await page.getByRole('radio', { name: /Card \(test gateway\)/ }).check();
  await page.getByRole('button', { name: 'Place order' }).click();

  // The gateway's page: paying sends a signed webhook; the order page then shows it paid.
  await expect(page.getByRole('heading', { name: 'Test card payment' })).toBeVisible();
  await page.getByRole('button', { name: 'Pay ₦5,000.00' }).click();
  const heading = page.getByRole('heading', { name: /Order WEB-\d+/ });
  await expect(heading).toBeVisible();
  orderNumber = ((await heading.textContent()) ?? '').replace('Order', '').trim();
  await expect(page.getByText('Paid', { exact: true }).first()).toBeVisible(); // status badge (also in the progress list)
  await expect(page.getByRole('link', { name: 'Cart, 0 items' })).toBeVisible();
});

test('staff see the paid online order and start processing it', async ({ page }) => {
  expect(orderNumber).toMatch(/^WEB-/);
  await staffLogin(page);
  await page.goto(`${E2E.urls.backoffice}/orders`);
  await page.getByRole('link', { name: orderNumber }).click();
  await expect(page.getByRole('heading', { name: `Order ${orderNumber}` })).toBeVisible();
  await expect(page.getByRole('link', { name: /^S-\d+$/ })).toBeVisible(); // the online sale
  await page.getByRole('button', { name: 'Start processing' }).click();
  await expect(page.getByRole('button', { name: 'Mark packed' })).toBeVisible();
});

test('a cashier opens a shift and rings up a cash sale; the dashboard shows it', async ({ page }) => {
  await staffLogin(page);
  await page.goto(`${E2E.urls.backoffice}/pos`);
  await page.getByLabel(/Opening cash float/).fill('5000');
  await page.getByRole('button', { name: 'Open shift' }).click();

  const scanner = page.getByRole('combobox', { name: 'Scan or search a product' });
  await scanner.fill(E2E.product.sku);
  await scanner.press('Enter');
  await expect(page.getByLabel(new RegExp(`Quantity of ${E2E.product.name}`))).toHaveValue('1');
  await expect(page.getByTestId('cart-total')).toHaveText(/2,500\.00/);

  await page.getByRole('button', { name: /^Pay/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Take payment' });
  await dialog.getByLabel('Cash received').fill('3000');
  await dialog.getByRole('button', { name: 'Complete sale' }).click();
  await expect(page.getByRole('heading', { name: /Sale S-\d+ complete/ })).toBeVisible();
  await expect(page.getByText('Change: ₦500.00')).toBeVisible();
  await page.getByRole('button', { name: 'New sale' }).click();

  await page.goto(`${E2E.urls.backoffice}/`);
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  // Two sales today: the online order and the till sale.
  await expect(page.getByText('2 sales', { exact: false })).toBeVisible();
});
