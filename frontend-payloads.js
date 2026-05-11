/**
 * examples/frontend-payloads.js
 *
 * Примеры payload для отправки заявок в create-request функцию.
 *
 * Это пример того, какие JSON-данные должен отправлять фронт.
 *
 * Все формы отправляются на одну и ту же Cloud Function:
 * create-request
 */

const CREATE_REQUEST_FUNCTION_URL = 'https://functions.yandexcloud.net/your-create-request-function-id';

/**
 * Универсальная функция отправки заявки.
 *
 * Ее можно использовать на фронте для любой формы.
 */
async function sendLead(payload) {
  const response = await fetch(CREATE_REQUEST_FUNCTION_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const result = await response.json().catch(() => null);

  if (!response.ok || !result?.ok) {
    throw new Error(result?.message || result?.error || 'Lead request failed');
  }

  return result;
}

/**
 * =========================
 * 1. ОБРАТНЫЙ ЗВОНОК
 * =========================
 *
 * type: callback_request
 *
 * Минимально нужны:
 * - phone
 *
 * Желательно:
 * - name
 * - page_url
 * - page_title
 */
async function sendCallbackRequest({ name, phone }) {
  return sendLead({
    type: 'callback_request',

    name,
    phone,

    page_url: window.location.href,
    page_title: document.title,
    submitted_at: new Date().toLocaleString(),
  });
}

/**
 * =========================
 * 2. ЗАКАЗ В ОДИН КЛИК
 * =========================
 *
 * type: one_click_order
 *
 * Для заказа лучше передавать:
 * - full_name
 * - phone
 * - comment
 * - product_name
 * - product_price
 * - page_url
 */
async function sendOneClickOrder({
  fullName,
  phone,
  comment,
  productName,
  productPrice,
}) {
  return sendLead({
    type: 'one_click_order',

    full_name: fullName,
    phone,
    comment: comment || '',

    product_name: productName || 'Товар',
    product_price: productPrice || '',

    page_url: window.location.href,
    page_title: document.title,
    submitted_at: new Date().toLocaleString(),
  });
}

/**
 * =========================
 * 3. ПРЕДЗАКАЗ
 * =========================
 *
 * type: preorder_request
 *
 * Пример для формы товара не в наличии.
 */
async function sendPreorderRequest({
  name,
  phone,
  productName,
}) {
  return sendLead({
    type: 'preorder_request',

    name,
    phone,

    product_name: productName || 'Товар для предзаказа',

    page_url: window.location.href,
    page_title: document.title,
    submitted_at: new Date().toLocaleString(),
  });
}

/**
 * =========================
 * 4. ПОДБОР АЛЬТЕРНАТИВЫ
 * =========================
 *
 * type: alternative_request
 *
 * Пример для формы “подобрать похожую модель”.
 */
async function sendAlternativeRequest({
  name,
  phone,
  productName,
}) {
  return sendLead({
    type: 'alternative_request',

    name,
    phone,

    product_name: productName || 'Товар, которого нет в наличии',

    page_url: window.location.href,
    page_title: document.title,
    submitted_at: new Date().toLocaleString(),
  });
}

/**
 * =========================
 * ПРИМЕР ПОДКЛЮЧЕНИЯ К ФОРМЕ
 * =========================
 *
 * Ниже пример, как можно повесить отправку на обычную HTML-форму.
 *
 * HTML:
 *
 * <form class="callback-form">
 *   <input name="name" />
 *   <input name="phone" />
 *   <button type="submit">Отправить</button>
 * </form>
 */

const callbackForm = document.querySelector('.callback-form');

if (callbackForm) {
  callbackForm.addEventListener('submit', async (event) => {
    event.preventDefault();

    const formData = new FormData(callbackForm);

    const name = String(formData.get('name') || '').trim();
    const phone = String(formData.get('phone') || '').trim();

    try {
      await sendCallbackRequest({
        name,
        phone,
      });

      alert('Спасибо! Мы скоро свяжемся с вами.');
      callbackForm.reset();
    } catch (error) {
      console.error(error);
      alert('Не удалось отправить заявку. Попробуйте еще раз.');
    }
  });
}

/**
 * =========================
 * ПРИМЕР ДЛЯ ФОРМ НЕ В НАЛИЧИИ
 * =========================
 *
 *
 * .out-of-stock-callback__form--preorder
 * .out-of-stock-callback__form--alternative
 *
 * Ниже пример, как определить тип заявки по классу формы.
 */

function getProductNameFromPage() {
  const title =
    document.querySelector('h1') ||
    document.querySelector('.product-title') ||
    document.querySelector('[data-product-title]');

  return title ? title.textContent.trim() : 'Товар';
}

document.querySelectorAll('.out-of-stock-callback__form').forEach((form) => {
  form.addEventListener('submit', async (event) => {
    event.preventDefault();

    const formData = new FormData(form);

    const name = String(formData.get('name') || '').trim();
    const phone = String(formData.get('phone') || '').trim();
    const productName = getProductNameFromPage();

    try {
      if (form.classList.contains('out-of-stock-callback__form--preorder')) {
        await sendPreorderRequest({
          name,
          phone,
          productName,
        });
      } else if (form.classList.contains('out-of-stock-callback__form--alternative')) {
        await sendAlternativeRequest({
          name,
          phone,
          productName,
        });
      } else {
        await sendCallbackRequest({
          name,
          phone,
        });
      }

      alert('Спасибо! Заявка отправлена.');
      form.reset();
    } catch (error) {
      console.error(error);
      alert('Не удалось отправить заявку. Попробуйте еще раз.');
    }
  });
});
