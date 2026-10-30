import { fullTime } from "../format.ts";

interface Line {
  readonly name: string;
  readonly qty: number;
  readonly price: string;
}

interface Shown {
  readonly shop: { readonly id: string; readonly name: string };
  readonly items: readonly Line[];
  readonly total: string;
  readonly currency: string;
  readonly expires: string;
}

/** The payment in a text a board signs, when it is one ({"kind":"buy", ...}); null for anything else. */
function paymentIn(text: string): Shown | null {
  try {
    const value = JSON.parse(text) as Partial<Shown> & { readonly kind?: unknown };
    if (value.kind !== "buy" || !value.shop || !Array.isArray(value.items) || typeof value.total !== "string" || typeof value.currency !== "string") return null;
    return value as Shown;
  } catch {
    return null;
  }
}

const money = (value: string, currency: string) => (currency === "USD" ? `$${value}` : `${value} ${currency}`);

/**
 * A payment waiting for your board, as the board will show it: the shop (its name and its own address), each
 * line, the total, and until when the signature can be given. Read from the very text the board signs.
 */
export function PaymentSummary({ text }: { readonly text: string }) {
  const payment = paymentIn(text);
  if (!payment) return null;
  return (
    <div className="payment">
      <p className="payment-shop">
        <strong>{payment.shop.name}</strong> <span className="hint">{payment.shop.id}</span>
      </p>
      <table className="payment-lines">
        <tbody>
          {payment.items.map((item, index) => (
            <tr key={index}>
              <td className="num">{item.qty}×</td>
              <td>{item.name}</td>
              <td className="num">{money(item.price, payment.currency)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td />
            <td>Total</td>
            <td className="num">{money(payment.total, payment.currency)}</td>
          </tr>
        </tfoot>
      </table>
      <p className="hint">
        Your board shows these same lines. It can sign until <time dateTime={payment.expires}>{fullTime(payment.expires)}</time>; after that the run asks again.
      </p>
    </div>
  );
}
