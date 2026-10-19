import type { RouteObject } from 'react-router';
import { LoginPage, RegisterPage } from './account/AuthPages';
import { ForgotPasswordPage, ResetPasswordPage } from './account/PasswordResetPages';
import { MyOrderPage, MyOrdersPage } from './account/OrderPages';
import { StoreLayout } from './layout/StoreLayout';
import { CartPage } from './pages/CartPage';
import { CheckoutPage } from './pages/CheckoutPage';
import { HomePage } from './pages/HomePage';
import { NotFoundPage } from './pages/NotFoundPage';
import { ProductPage } from './pages/ProductPage';
import { ShopPage } from './pages/ShopPage';
import { TestPayPage } from './pages/TestPayPage';

export const routes: RouteObject[] = [
  {
    element: <StoreLayout />,
    children: [
      { index: true, element: <HomePage /> },
      { path: 'shop', element: <ShopPage /> },
      { path: 'products/:slug', element: <ProductPage /> },
      { path: 'cart', element: <CartPage /> },
      { path: 'checkout', element: <CheckoutPage /> },
      { path: 'account/login', element: <LoginPage /> },
      { path: 'account/register', element: <RegisterPage /> },
      { path: 'account/forgot-password', element: <ForgotPasswordPage /> },
      { path: 'account/reset-password', element: <ResetPasswordPage /> },
      { path: 'account/orders', element: <MyOrdersPage /> },
      { path: 'account/orders/:number', element: <MyOrderPage /> },
      { path: 'pay/test/:reference', element: <TestPayPage /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
];
