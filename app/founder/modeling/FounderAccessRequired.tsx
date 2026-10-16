// Shown instead of a bare 404 when the signed Founder session is absent/invalid. Static text only:
// no data, no identity, no configuration state and no secret is disclosed.
export default function FounderAccessRequired() {
  return <main style={{ background: "#0d141c", color: "#e9eef5", padding: 24, minHeight: "100vh", fontSize: 15, lineHeight: 1.6 }}>
    <h1 style={{ fontSize: 24 }}>Нужен вход основателя (Founder)</h1>
    <p>Эта страница доступна только по специальной Founder-сессии. Сейчас у вашего браузера такой сессии нет или она истекла (она действует 24 часа).</p>
    <h2 style={{ fontSize: 18 }}>Почему обычный вход не подходит</h2>
    <p>Обычная подписка Premium и вход по ссылке из письма (magic link) выдают клиентскую сессию. Она намеренно не открывает Founder Modeling: доступ Premium не равен доступу основателя.</p>
    <h2 style={{ fontSize: 18 }}>Как войти</h2>
    <ol>
      <li>Откройте личную ссылку Founder Preview, выданную владельцем платформы (она ведёт через /api/auth/founder-premium-preview и содержит секретный токен).</li>
      <li>После входа вы окажетесь на странице Premium — затем откройте /founder/modeling снова в том же браузере.</li>
      <li>Если ссылка не работает, токен или режим Founder Preview нужно выдать заново на стороне сервера. Эту настройку делает только владелец; на этой странице она не меняется.</li>
    </ol>
    <p style={{ opacity: 0.75 }}>Данные, API и вложенные отчёты по-прежнему закрыты без Founder-сессии.</p>
  </main>;
}
