using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;

namespace PiikDesktop
{
    /// <summary>Small JSON helper so the single-file host needs no extra dependency.</summary>
    internal static class SimpleJson
    {
        public static string Quote(string value)
        {
            if (value == null) return "null";
            var builder = new StringBuilder(value.Length + 2);
            builder.Append('"');
            foreach (var character in value)
            {
                switch (character)
                {
                    case '"': builder.Append("\\\""); break;
                    case '\\': builder.Append("\\\\"); break;
                    case '\b': builder.Append("\\b"); break;
                    case '\f': builder.Append("\\f"); break;
                    case '\n': builder.Append("\\n"); break;
                    case '\r': builder.Append("\\r"); break;
                    case '\t': builder.Append("\\t"); break;
                    default:
                        if (character < ' ') builder.Append("\\u").Append(((int)character).ToString("x4", CultureInfo.InvariantCulture));
                        else builder.Append(character);
                        break;
                }
            }
            builder.Append('"');
            return builder.ToString();
        }

        public static Dictionary<string, object> ParseObject(string json)
        {
            var parser = new Parser(json ?? "");
            var value = parser.ParseValue();
            return value as Dictionary<string, object> ?? new Dictionary<string, object>();
        }

        public static object Parse(string json)
        {
            return new Parser(json ?? "").ParseValue();
        }

        public static string Stringify(object value)
        {
            var builder = new StringBuilder();
            Write(builder, value);
            return builder.ToString();
        }

        private static void Write(StringBuilder builder, object value)
        {
            if (value == null) { builder.Append("null"); return; }
            if (value is string text) { builder.Append(Quote(text)); return; }
            if (value is bool boolean) { builder.Append(boolean ? "true" : "false"); return; }
            if (value is int || value is long || value is short || value is byte) { builder.Append(Convert.ToString(value, CultureInfo.InvariantCulture)); return; }
            if (value is float || value is double || value is decimal)
            {
                var number = Convert.ToDouble(value, CultureInfo.InvariantCulture);
                builder.Append(number.ToString("R", CultureInfo.InvariantCulture));
                return;
            }
            if (value is IDictionary<string, object> map)
            {
                builder.Append('{');
                var first = true;
                foreach (var pair in map)
                {
                    if (!first) builder.Append(',');
                    first = false;
                    builder.Append(Quote(pair.Key)).Append(':');
                    Write(builder, pair.Value);
                }
                builder.Append('}');
                return;
            }
            if (value is System.Collections.IEnumerable list)
            {
                builder.Append('[');
                var first = true;
                foreach (var item in list)
                {
                    if (!first) builder.Append(',');
                    first = false;
                    Write(builder, item);
                }
                builder.Append(']');
                return;
            }
            builder.Append(Quote(Convert.ToString(value, CultureInfo.InvariantCulture)));
        }

        private sealed class Parser
        {
            private readonly string _text;
            private int _index;

            public Parser(string text) { _text = text; }

            public object ParseValue()
            {
                SkipWhitespace();
                if (_index >= _text.Length) return null;
                var character = _text[_index];
                if (character == '{') return ParseMap();
                if (character == '[') return ParseList();
                if (character == '"') return ParseString();
                if (character == 't' && Match("true")) return true;
                if (character == 'f' && Match("false")) return false;
                if (character == 'n' && Match("null")) return null;
                return ParseNumber();
            }

            private Dictionary<string, object> ParseMap()
            {
                var map = new Dictionary<string, object>(StringComparer.OrdinalIgnoreCase);
                _index++;
                SkipWhitespace();
                if (Peek('}')) { _index++; return map; }
                while (true)
                {
                    SkipWhitespace();
                    var key = ParseString();
                    SkipWhitespace();
                    Expect(':');
                    map[key] = ParseValue();
                    SkipWhitespace();
                    if (Peek('}')) { _index++; return map; }
                    Expect(',');
                }
            }

            private List<object> ParseList()
            {
                var list = new List<object>();
                _index++;
                SkipWhitespace();
                if (Peek(']')) { _index++; return list; }
                while (true)
                {
                    list.Add(ParseValue());
                    SkipWhitespace();
                    if (Peek(']')) { _index++; return list; }
                    Expect(',');
                }
            }

            private string ParseString()
            {
                SkipWhitespace();
                Expect('"');
                var builder = new StringBuilder();
                while (_index < _text.Length)
                {
                    var character = _text[_index++];
                    if (character == '"') return builder.ToString();
                    if (character != '\\') { builder.Append(character); continue; }
                    if (_index >= _text.Length) break;
                    var escaped = _text[_index++];
                    switch (escaped)
                    {
                        case '"': builder.Append('"'); break;
                        case '\\': builder.Append('\\'); break;
                        case '/': builder.Append('/'); break;
                        case 'b': builder.Append('\b'); break;
                        case 'f': builder.Append('\f'); break;
                        case 'n': builder.Append('\n'); break;
                        case 'r': builder.Append('\r'); break;
                        case 't': builder.Append('\t'); break;
                        case 'u':
                            if (_index + 4 <= _text.Length)
                            {
                                builder.Append((char)int.Parse(_text.Substring(_index, 4), NumberStyles.HexNumber, CultureInfo.InvariantCulture));
                                _index += 4;
                            }
                            break;
                    }
                }
                return builder.ToString();
            }

            private object ParseNumber()
            {
                var start = _index;
                while (_index < _text.Length && "-+.eE0123456789".IndexOf(_text[_index]) >= 0) _index++;
                var text = _text.Substring(start, _index - start);
                if (text.IndexOf('.') >= 0 || text.IndexOf('e') >= 0 || text.IndexOf('E') >= 0)
                {
                    double number;
                    if (double.TryParse(text, NumberStyles.Float, CultureInfo.InvariantCulture, out number)) return number;
                }
                else
                {
                    long integer;
                    if (long.TryParse(text, NumberStyles.Integer, CultureInfo.InvariantCulture, out integer))
                    {
                        if (integer >= int.MinValue && integer <= int.MaxValue) return (int)integer;
                        return integer;
                    }
                }
                return 0;
            }

            private bool Match(string token)
            {
                if (_index + token.Length > _text.Length) return false;
                if (string.CompareOrdinal(_text, _index, token, 0, token.Length) != 0) return false;
                _index += token.Length;
                return true;
            }

            private void SkipWhitespace()
            {
                while (_index < _text.Length && char.IsWhiteSpace(_text[_index])) _index++;
            }

            private bool Peek(char character)
            {
                return _index < _text.Length && _text[_index] == character;
            }

            private void Expect(char character)
            {
                if (Peek(character)) { _index++; return; }
                throw new FormatException("Expected '" + character + "' at " + _index);
            }
        }
    }
}
