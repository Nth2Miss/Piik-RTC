// Keep this in sync with server/rooms/username.js.
const weakNames = new Set([
  'admin', 'root', 'test', 'guest', 'user', 'password',
  'qwerty', 'asdf', 'zxcv', 'qazwsx', 'abc', 'abcd', 'abcde',
]);

export function usernameError(value: string): string | null {
  const name = value.trim();
  if (!name) return '请输入用户名。';
  if (name.length < 2 || name.length > 24) return '用户名需为 2–24 个字。';
  if (/^\d+$/.test(name)) return '用户名不能全是数字，请换一个。';
  if (/^([a-z0-9])\1+$/i.test(name)) return '用户名不能是重复字符，请换一个。';
  const lower = name.toLocaleLowerCase();
  if (weakNames.has(lower)) return '这个用户名太简单，请换一个。';
  if (/^[a-z]+$/i.test(name)) {
    const codes = [...lower].map(character => character.codePointAt(0)!);
    const step = codes[1] - codes[0];
    if (codes.length >= 3 && (step === 1 || step === -1)
      && codes.every((code, index) => index === 0 || code - codes[index - 1] === step)) {
      return '用户名不能是连续字符，请换一个。';
    }
  }
  return null;
}
