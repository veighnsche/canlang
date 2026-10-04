#!/usr/bin/env python3
"""Initial canlang syntax parser. No symbol/type checking or runtime execution."""
from __future__ import annotations

import argparse
from dataclasses import dataclass, field
import json
from pathlib import Path
import re
import sys


@dataclass(frozen=True)
class Token:
    kind: str
    text: str
    line: int
    column: int
    path: str
    value: object = None


class ParseError(Exception):
    def __init__(self, token, message, code="syntax"):
        self.token, self.message, self.code = token, message, code
        self.line, self.column = token.line, token.column
        super().__init__(f"{token.path}:{token.line}:{token.column}: {code}: {message}")


@dataclass
class Node:
    kind: str
    token: Token
    data: dict

    def to_dict(self):
        def convert(value):
            if isinstance(value, Node):
                return value.to_dict()
            if isinstance(value, list):
                return [convert(v) for v in value]
            if isinstance(value, dict):
                return {k: convert(v) for k, v in value.items()}
            return value
        return {"kind": self.kind, "location": {"file": self.token.path,
                "line": self.token.line, "column": self.token.column},
                **convert(self.data)}


def node(kind, token, **data):
    return Node(kind, token, data)


@dataclass
class Line:
    indent: int
    tokens: list[Token]
    children: list[Line] = field(default_factory=list)


_NAME = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
_NUMBER = re.compile(r"[0-9]+\.[0-9]+|[0-9]+(?:GiB|MiB|KiB|ms|B|s|m|h|d)?")
_SYMBOLS = ("?.", "??", "==", "!=", "<=", ">=", "->")


def lex(source, path="<input>"):
    """Return logical lines, preserving physical field descriptions in braces."""
    source = source.replace("\r\n", "\n")
    if "\r" in source:
        prefix = source[:source.index("\r")]
        raise ParseError(Token("", "\r", prefix.count("\n") + 1,
                               len(prefix.rsplit("\n", 1)[-1]) + 1, path),
                         "bare carriage return is not a line ending", "lexical")
    lines, pending, brackets = [], [], []
    indent = 0
    for number, physical in enumerate(source.split("\n"), 1):
        leading = len(physical) - len(physical.lstrip(" "))
        body = physical[leading:]
        if not body:
            continue
        if body.startswith("##"):
            continue
        if body.startswith("#"):
            description_text = body[2:] if body.startswith("# ") else body[1:]
            description = Token("DESC", body, number, leading + 1, path, description_text)
            if brackets:
                pending.append(description)
            else:
                lines.append(Line(leading, [description]))
            continue
        if not pending:
            indent = leading
        index = leading
        while index < len(physical):
            char = physical[index]
            token = Token("", char, number, index + 1, path)
            if char == " ":
                index += 1
                continue
            if char == '"':
                end = index + 1
                escaped = False
                while end < len(physical):
                    if physical[end] == '"' and not escaped:
                        break
                    if physical[end] == "\\" and not escaped:
                        escaped = True
                    else:
                        escaped = False
                    end += 1
                if end == len(physical):
                    raise ParseError(token, "unterminated JSON string", "lexical")
                text = physical[index:end + 1]
                try:
                    value = json.loads(text)
                except json.JSONDecodeError as error:
                    raise ParseError(token, f"invalid JSON string: {error.msg}", "lexical") from None
                pending.append(Token("STRING", text, number, index + 1, path, value))
                index = end + 1
                continue
            match = _NAME.match(physical, index)
            if match:
                text = match.group()
                pending.append(Token("NAME", text, number, index + 1, path))
                index = match.end()
                continue
            match = _NUMBER.match(physical, index)
            if match:
                text = match.group()
                if match.end() < len(physical) and (physical[match.end()].isalnum() or physical[match.end()] == "_"):
                    raise ParseError(token, "invalid numeric literal or unit", "lexical")
                pending.append(Token("NUMBER", text, number, index + 1, path))
                index = match.end()
                continue
            symbol = next((s for s in _SYMBOLS if physical.startswith(s, index)), char)
            if symbol not in _SYMBOLS and char not in "()[]{}.,:;=+-*/%<>!?|@":
                raise ParseError(token, f"unexpected character {char!r}", "lexical")
            item = Token("OP", symbol, number, index + 1, path)
            if symbol in "([{":
                brackets.append(item)
            elif symbol in ")]}":
                if not brackets or {"(": ")", "[": "]", "{": "}"}[brackets[-1].text] != symbol:
                    raise ParseError(item, "unmatched closing delimiter", "lexical")
                brackets.pop()
            pending.append(item)
            index += len(symbol)
        if not brackets:
            lines.append(Line(indent, pending))
            pending = []
    if brackets:
        raise ParseError(brackets[-1], "unclosed delimiter", "lexical")
    return lines


def layout(lines):
    roots, levels = [], []
    for line in lines:
        if not levels:
            if line.indent:
                raise ParseError(line.tokens[0], "top-level declaration must start in column 1", "indentation")
            roots.append(line)
            levels = [line]
        elif line.indent == len(levels):
            levels[-1].children.append(line)
            levels.append(line)
        elif line.indent < len(levels):
            levels = levels[:line.indent]
            (levels[-1].children if levels else roots).append(line)
            levels.append(line)
        else:
            raise ParseError(line.tokens[0], "child block must add exactly one space", "indentation")
    return roots


def fragment_tokens(fragment, token, offset):
    """Lex metadata syntax while retaining its physical source coordinates."""
    try:
        logical = lex(fragment, token.path)
    except ParseError as error:
        item = error.token
        located = Token(item.kind, item.text, token.line + item.line - 1,
                        token.column + offset + item.column - 1, token.path, item.value)
        raise ParseError(located, error.message, error.code) from None
    return [Token(item.kind, item.text, token.line + item.line - 1,
                  token.column + offset + item.column - 1, token.path, item.value)
            for line in logical for item in line.tokens]


def description_data(tokens, target):
    """Decode literal, inline-translated or static-reference description metadata."""
    if not tokens:
        return {}
    for token in tokens:
        if token.column != target.column:
            raise ParseError(token, "description and declaration must occupy the same column")
    references = [token for token in tokens if token.text.startswith("#=")]
    if references:
        if len(tokens) != 1:
            raise ParseError(tokens[1], "one description cannot mix prose and references or contain multiple references")
        token = references[0]
        cursor = Cursor(fragment_tokens(token.text[2:], token, 2))
        path = cursor.path()
        cursor.finish()
        return {"description_ref": node("description_ref", token, path=path)}
    prose, suffix = [], None
    for index, token in enumerate(tokens):
        prefix = 2 if token.text.startswith("# ") else 1
        content = token.text[prefix:]
        chars, position = [], 0
        while position < len(content):
            if content.startswith("\\@{", position):
                chars.append("@{"); position += 3
            elif content.startswith("@{", position):
                if index != len(tokens) - 1:
                    raise ParseError(token, "description suffix must occupy the final prose line")
                if chars and chars[-1] == " ":
                    chars.pop()
                suffix = Cursor(fragment_tokens(content[position:], token, prefix + position))
                break
            else:
                chars.append(content[position]); position += 1
        prose.append("".join(chars))
    text = "\n".join(prose)
    if suffix is None:
        return {"description": text}
    first = tokens[0]
    prefix = 2 if first.text.startswith("# ") else 1
    source_token = Token("STRING", text, first.line, first.column + prefix, first.path, text)
    value = suffix.message_suffix(node("literal", source_token, value=text, literal_type="text"))
    suffix.finish()
    return {"description": value}


class Cursor:
    def __init__(self, tokens):
        self.tokens, self.i = tokens, 0
        last = tokens[-1] if tokens else Token("EOF", "", 1, 1, "<input>")
        self.eof = Token("EOF", "", last.line, last.column + len(last.text), last.path)

    def peek(self, offset=0):
        at = self.i + offset
        return self.tokens[at] if at < len(self.tokens) else self.eof

    def at(self, text):
        return self.peek().text == text

    def done(self):
        return self.i >= len(self.tokens)

    def fail(self, message, token=None):
        raise ParseError(token or self.peek(), message)

    def take(self, text=None):
        token = self.peek()
        if self.done() or text is not None and token.text != text:
            self.fail(f"expected {text or 'token'}", token)
        self.i += 1
        return token

    def name(self):
        if self.peek().kind != "NAME":
            self.fail("expected identifier")
        return self.take()

    def finish(self):
        if not self.done():
            self.fail(f"unexpected token {self.peek().text!r}")

    def path(self):
        start = self.name()
        parts = [start.text]
        while self.at("."):
            self.take()
            parts.append(self.name().text)
        return node("path", start, parts=parts)

    def message_suffix(self, source):
        marker = self.take("@")
        opening = self.take("{")
        if opening.line != marker.line or opening.column != marker.column + 1:
            self.fail("message suffix marker must be contiguous @{", opening)
        variants, seen = [], set()
        while not self.at("}"):
            key = self.take()
            if key.kind not in {"NAME", "STRING"}:
                self.fail("message locale key must be an identifier or quoted tag", key)
            locale = key.value if key.kind == "STRING" else key.text
            folded = locale.casefold()
            if folded in seen:
                self.fail("duplicate message locale variant", key)
            seen.add(folded)
            self.take("="); token = self.take()
            if token.kind != "STRING" and token.text != "null":
                self.fail("message variant requires a JSON string or null", token)
            value = node("literal", token, value=token.value if token.kind == "STRING" else None,
                         literal_type="text")
            variants.append(node("message_variant", key, locale=locale, value=value))
            if not self.at(","):
                break
            self.take(",")
        self.take("}")
        return node("message_value", source.token, source=source, variants=variants)

    def caption(self):
        if self.peek().kind == "STRING":
            token = self.take()
            value = node("literal", token, value=token.value, literal_type="text")
            return self.message_suffix(value) if self.at("@") else value
        return self.path()

    def label(self, shape="scalar"):
        if not self.at("{"):
            if shape == "crud":
                self.fail("CRUD label requires a closed operation map")
            return self.caption()
        if shape == "scalar":
            self.fail("this declaration label requires a scalar caption")
        opening = self.take("{")
        attrs = {}
        allowed = {"text", "values"} if shape == "field" else {"create", "update", "delete"}
        while not self.at("}"):
            key = self.name()
            if key.text not in allowed:
                self.fail("unsupported label slot " + key.text, key)
            if key.text in attrs:
                self.fail("duplicate label slot " + key.text, key)
            self.take("=")
            if key.text == "values":
                self.take("{"); cases, seen = [], set()
                while not self.at("}"):
                    case = self.name()
                    if case.text in seen:
                        self.fail("duplicate label case", case)
                    seen.add(case.text); self.take("=")
                    cases.append(node("label_case", case, name=case.text, value=self.caption()))
                    if not self.at(","):
                        break
                    self.take(",")
                self.take("}")
                if not cases:
                    self.fail("label values must contain at least one case", key)
                attrs[key.text] = cases
            else:
                attrs[key.text] = self.caption()
            if not self.at(","):
                break
            self.take(",")
        self.take("}")
        if not attrs:
            self.fail("label object must contain at least one slot", opening)
        return node("label" if shape == "field" else "crud_labels", opening,
                    **attrs if shape == "field" else {"operations": attrs})

    def type(self, field=False):
        start = self.peek()
        if self.peek().text in ("enum", "action") and self.peek(1).text == "(":
            kind = self.take().text
            self.take("(")
            def item():
                if kind == "action":
                    return self.path()
                name = self.name()
                return node("path", name, parts=[name.text])
            items = [item()]
            while self.at(","):
                self.take()
                if self.at(")"):
                    break
                items.append(item())
            self.take(")")
            result = node(kind + "_type", start, items=items)
        else:
            items = [self.path()]
            while self.at("|"):
                self.take()
                items.append(self.path())
            result = node("named_type" if len(items) == 1 else "union_type", start, names=items)
        if self.at("["):
            self.take("["); self.take("]")
            result = node("array_type", start, element=result)
        if self.at("?"):
            self.take()
            result = node("nullable_type", start, value=result)
        if self.peek().text in ("[", "?", "|", "("):
            self.fail("type permits one array suffix followed by one nullable suffix")
        return result

    def _field(self, parameter=False):
        descriptions = []
        while self.peek().kind == "DESC":
            descriptions.append(self.take())
        start = self.name()
        metadata = description_data(descriptions, start) if descriptions else {"description": None}
        self.take(":")
        value_type = self.type()
        required = False
        if self.at("!"):
            marker = self.take()
            reusable = value_type.kind == "named_type" and len(value_type.data["names"][0].data["parts"]) > 1
            if parameter or value_type.kind != "array_type" and not reusable:
                self.fail("! is required-array field metadata, not a scalar/parameter suffix", marker)
            required = True
        attrs = {}
        if self.at("="):
            self.take()
            attrs["default"] = self.expr(stop={"trim", "min", "max", "unique", "server", "label"})
        elif self.at("server"):
            modifier = self.take()
            if parameter:
                self.fail("parameters do not accept server initialization", modifier)
            self.take("=")
            attrs["server"] = self.expr(stop={"trim", "min", "max", "unique", "server", "label"})
        while self.peek().text in {"trim", "unique", "min", "max"}:
            modifier = self.take()
            if parameter:
                self.fail("parameters do not accept stored-field modifiers", modifier)
            if modifier.text in attrs:
                self.fail("duplicate field modifier", modifier)
            if modifier.text in ("trim", "unique"):
                attrs[modifier.text] = True
            else:
                self.take("=")
                attrs[modifier.text] = self.expr(stop={"trim", "min", "max", "unique", "server", "label"})
        if self.at("label"):
            self.take(); self.take("="); attrs["label"] = self.label("field")
        if "default" in attrs and "server" in attrs:
            self.fail("field cannot have both default and server initialization", start)
        if required and ("default" in attrs or "server" in attrs):
            self.fail("required-array field cannot also initialize its input", start)
        return node("parameter" if parameter else "field", start, name=start.text,
                    type=value_type, required_array=required, attributes=attrs,
                    **metadata)

    def fields(self):
        self.take("{")
        result = []
        while not self.at("}"):
            result.append(self._field())
            if not self.at(","):
                break
            self.take()
        self.take("}")
        return result

    def params(self):
        self.take("(")
        result = []
        while not self.at(")"):
            result.append(self._field(parameter=True))
            if not self.at(","):
                break
            self.take()
        self.take(")")
        return result

    def object(self):
        start = self.take("{")
        items, seen = [], set()
        while not self.at("}"):
            key = self.name()
            if key.text in seen:
                self.fail("duplicate object field", key)
            seen.add(key.text)
            if self.at("="):
                self.take()
                value = self.expr()
            else:
                value = node("name", key, name=key.text)
            items.append(node("entry", key, name=key.text, value=value))
            if not self.at(","):
                break
            self.take()
        self.take("}")
        return node("object", start, entries=items)

    def expr(self, stop=None, query=True, construct=True):
        stop = set(stop or ())
        value = self._value(0, stop, construct)
        if not query:
            return value
        clauses, alias, last = {}, None, -1
        ranks = {"archived": 0, "as": 1, "where": 2, "order": 3, "select": 4}
        while self.peek().text in ranks:
            text = self.peek().text
            if text in stop and (text in {"as", "select", "where"} or self.peek(1).text == "="):
                break
            if text in {"archived", "order"} and self.peek(1).text != "=":
                break
            token = self.take()
            rank = ranks[text]
            if rank <= last:
                self.fail("query clauses are unique and ordered archived/as/where/order/select", token)
            last = rank
            if text == "as":
                alias = self.name().text
            elif text == "archived":
                self.take("="); self.take("include")
                clauses[text] = True
            else:
                if text == "order":
                    self.take("=")
                clauses[text] = self._value(0, stop | set(ranks), True)
        return node("query", value.token, domain=value, alias=alias, clauses=clauses) if last >= 0 else value

    def _stopped(self, stop):
        token = self.peek()
        if token.kind == "EOF" or token.text in (",", ")", "]", "}", ";", "->"):
            return True
        if token.text in stop:
            # A bare modifier/terminator follows a completed value; NAME= is an attribute.
            return True
        return token.kind == "NAME" and self.peek(1).text == "="

    def _value(self, minimum, stop, construct):
        start = self.peek()
        if start.text in ("not", "-"):
            if start.text == "not" and minimum > 35:
                self.fail("parenthesize not when used as an arithmetic/comparison operand", start)
            self.take()
            left = node("unary", start, operator=start.text,
                        value=self._value(35 if start.text == "not" else 70, stop, construct))
        elif start.kind == "STRING":
            self.take(); left = node("literal", start, value=start.value, literal_type="text")
            if self.at("@"):
                left = self.message_suffix(left)
        elif start.kind == "NUMBER":
            self.take()
            numeric, unit = re.fullmatch(r"([0-9]+(?:\.[0-9]+)?)([A-Za-z]*)", start.text).groups()
            kind = "duration" if unit in {"ms", "s", "m", "h", "d"} else "bytes" if unit else "decimal" if "." in numeric else "integer"
            left = node("literal", start, value=numeric, literal_type=kind, unit=unit or None)
        elif start.text in ("true", "false", "null"):
            self.take(); left = node("literal", start, value={"true": True, "false": False, "null": None}[start.text])
        elif start.kind == "NAME":
            self.take(); left = node("name", start, name=start.text)
        elif start.text == "(":
            self.take(); inner = self.expr(); self.take(")")
            left = node("group", start, value=inner)
        elif start.text == "[":
            self.take(); values = []
            while not self.at("]"):
                values.append(self.expr())
                if not self.at(","):
                    break
                self.take()
            self.take("]")
            left = node("array", start, values=values)
        elif start.text == "{":
            left = self.object()
        else:
            self.fail("expected value expression", start)
        while True:
            text = self.peek().text
            if text in (".", "?."):
                operator = self.take(); member = self.name()
                left = node("member", left.token, receiver=left, name=member.text, optional=operator.text == "?.")
            elif text == "(":
                if left.kind == "member" and left.data["optional"]:
                    self.fail("optional calls are not supported")
                callee = left
                while callee.kind == "group":
                    callee = callee.data["value"]
                anonymous = callee.kind == "message_value"
                self.take(); args, names, named = [], set(), False
                while not self.at(")"):
                    key = None
                    if self.peek().kind == "NAME" and self.peek(1).text == "=":
                        name = self.take(); self.take("=")
                        if name.text in names:
                            self.fail("duplicate named argument", name)
                        names.add(name.text); named = True; key = name.text
                    elif anonymous:
                        self.fail("anonymous message arguments must be explicitly named")
                    elif named:
                        self.fail("positional arguments must precede named arguments")
                    value = self.expr()
                    args.append(node("argument", value.token, name=key, value=value))
                    if not self.at(","):
                        break
                    self.take()
                self.take(")")
                if anonymous and not args:
                    self.fail("omit an empty anonymous message call", left.token)
                left = node("call", left.token, callee=left, arguments=args)
            elif text == "{" and construct and "{" not in stop:
                if not self.is_path(left):
                    self.fail("typed value constructor requires a type path")
                left = node("construct", left.token, type=left, value=self.object())
            elif text == "[":
                self.fail("postfix indexing is unsupported; use at(array,index)")
            else:
                break
        precedence = {"??": 10, "or": 20, "and": 30, "==": 40, "!=": 40,
                      "<": 40, "<=": 40, ">": 40, ">=": 40, "in": 40, "is": 40,
                      "+": 50, "-": 50, "*": 60, "/": 60, "%": 60}
        while not self._stopped(stop) and self.peek().text in precedence:
            operator = self.peek()
            power = precedence[operator.text]
            if power < minimum:
                break
            if power == 40 and left.kind == "binary" and left.data["operator"] in {"==", "!=", "<", "<=", ">", ">=", "in", "is"}:
                self.fail("comparisons cannot chain", operator)
            self.take()
            right = self._value(power if operator.text == "??" else power + 1, stop, construct)
            left = node("binary", left.token, operator=operator.text, left=left, right=right)
            kinds = self._boolean_kinds(left)
            if "??" in kinds and ("and" in kinds or "or" in kinds):
                self.fail("parenthesize mixing of ?? with and/or", operator)
        return left

    @staticmethod
    def is_path(value):
        return value.kind == "name" or (value.kind == "member" and not value.data["optional"]
                                       and Cursor.is_path(value.data["receiver"]))

    @staticmethod
    def _boolean_kinds(value):
        if value.kind != "binary":
            return set()
        return {value.data["operator"]} | Cursor._boolean_kinds(value.data["left"]) | Cursor._boolean_kinds(value.data["right"])
class Parser:
    """Parse declaration and suite structure after lexical line assembly."""
    def __init__(self, lines):
        self.lines = lines

    def _end(self, c):
        if not c.done():
            c.fail("expected end of statement")

    def _split(self, line):
        pieces, current, depth = [], [], 0
        for token in line.tokens:
            if token.text in ('(', '[', '{'):
                depth += 1
            elif token.text in (')', ']', '}'):
                depth -= 1
            if token.text == ';' and depth == 0:
                if not current:
                    raise ParseError(token, "empty semicolon statement")
                pieces.append(current)
                current = []
            else:
                current.append(token)
        if not current:
            raise ParseError(line.tokens[-1], "trailing semicolon is not supported")
        pieces.append(current)
        if len(pieces) > 1 and line.children:
            raise ParseError(line.tokens[0], "semicolon sequences cannot own an indented suite")
        return pieces

    def _leaf(self, line):
        if line.children:
            raise ParseError(line.tokens[0], "this statement cannot own an indented suite")

    def _described(self, lines, callback):
        output, descriptions = [], []
        for line in lines:
            if line.tokens[0].kind == 'DESC':
                self._leaf(line)
                descriptions.append(line.tokens[0])
                continue
            pieces = self._split(line)
            for piece in pieces:
                part = Line(line.indent, piece, line.children)
                value = callback(part)
                if len(pieces) > 1 and value.kind in ('section', 'scenario', 'capability', 'page', 'nav', 'card', 'details'):
                    raise ParseError(value.token, 'compound declarations cannot form a semicolon sequence')
                if descriptions and value.kind in ('section', 'require', 'examples', 'example_row'):
                    raise ParseError(descriptions[0], 'description cannot attach to a guard or example; use ##')
                if descriptions:
                    value.data.update(description_data(descriptions, piece[0]))
                    descriptions = []
                output.append(value)
        if descriptions:
            raise ParseError(descriptions[0], "description has no following eligible declaration at the same indentation")
        return output

    def _selectors(self, c):
        values = []
        while True:
            sign = c.take('-') if c.at('-') else None
            value = c.path()
            if sign:
                value = node('descending', sign, value=value)
            values.append(value)
            if not c.at(','):
                break
            c.take(',')
        return values

    def _attrs(self, c, allowed, required=()):
        attrs = {}
        while not c.done():
            key = c.name()
            if key.text not in allowed:
                c.fail("unsupported attribute " + key.text, key)
            if key.text in attrs:
                c.fail("duplicate attribute " + key.text, key)
            c.take('=')
            kind = allowed[key.text]
            if kind == 'members':
                opening = c.take('['); values = []
                while not c.at(']'):
                    member = c.name(); values.append(node('name', member, name=member.text))
                    if not c.at(','): break
                    c.take(',')
                c.take(']'); value = node('array', opening, values=values)
            elif kind == 'selectors':
                value = self._selectors(c)
            elif kind == 'type':
                value = c.type()
            elif kind == 'path':
                value = c.path()
            elif kind == 'name':
                value = c.name().text
            elif kind == 'string':
                value = c.take()
                if value.kind != 'STRING':
                    c.fail("expected a double-quoted string", value)
                value = node('literal', value, value=value.value)
            elif kind in {'label', 'field_label', 'crud_label'}:
                value = c.label({'label': 'scalar', 'field_label': 'field', 'crud_label': 'crud'}[kind])
            elif kind == 'object':
                value = c.object()
            elif kind == 'route':
                value = self._route(c, set(allowed))
            else:
                value = c.expr(stop=set(allowed))
            attrs[key.text] = value
        for key in required:
            if key not in attrs:
                c.fail("missing required attribute " + key)
        return attrs

    def parse(self):
        declarations, pending = [], []
        i = 0
        while i < len(self.lines):
            line = self.lines[i]
            if line.tokens[0].kind == 'DESC':
                self._leaf(line)
                pending.append(line.tokens[0]); i += 1
                continue
            pieces = self._split(line)
            if len(pieces) != 1:
                raise ParseError(line.tokens[0], "top-level compound declarations cannot form a semicolon sequence")
            c = Cursor(line.tokens)
            head = c.peek()
            if head.text == 'app':
                c.take(); name = c.name()
                attrs = self._attrs(c, {'uses': 'members', 'source': 'string', 'label': 'label'})
                self._leaf(line)
                value = node('app', head, name=name.text, attributes=attrs, imports=[], sections=[], context=None)
                i += 1
                j = i
                context_descriptions = []
                while j < len(self.lines) and self.lines[j].tokens[0].kind == 'DESC':
                    self._leaf(self.lines[j]); context_descriptions.append(self.lines[j].tokens[0]); j += 1
                if j < len(self.lines) and self.lines[j].tokens[0].text == 'context':
                    context = self._context(self.lines[j])
                    if context_descriptions:
                        context.data.update(description_data(context_descriptions, context.token))
                    value.data['context'] = context; i = j + 1
                if 'uses' in attrs:
                    import_lines = []
                    while i < len(self.lines):
                        j = i
                        while j < len(self.lines) and self.lines[j].tokens[0].kind == 'DESC':
                            j += 1
                        if j == len(self.lines) or self.lines[j].tokens[0].text != 'use':
                            break
                        import_lines.extend(self.lines[i:j+1]); i = j + 1
                    value.data['imports'] = self._described(import_lines, self._import)
                else:
                    body = []
                    while i < len(self.lines):
                        candidate = self.lines[i]
                        if candidate.tokens[0].kind == 'DESC':
                            # Leave descriptions for the next top-level declaration if its head follows them.
                            j = i
                            while j < len(self.lines) and self.lines[j].tokens[0].kind == 'DESC': j += 1
                            if j == len(self.lines) or self.lines[j].tokens[0].text in ('app', 'package', 'migration'):
                                break
                        elif candidate.tokens[0].text in ('app', 'package', 'migration'):
                            break
                        body.append(candidate); i += 1
                    value.data.update(self._package_body(body, head))
            elif head.text == 'package':
                c.take(); name = c.name(); attrs = self._attrs(c, {'source': 'string', 'label': 'label'})
                if not line.children:
                    c.fail("package requires an ordered Given/When/Then body", head)
                value = node('package', head, name=name.text, attributes=attrs, **self._package_body(line.children, head)); i += 1
            elif head.text == 'migration':
                value = self._migration(line); i += 1
            else:
                c.fail("expected app, package or migration", head)
            if pending:
                value.data.update(description_data(pending, line.tokens[0]))
                pending = []
            declarations.append(value)
        if pending:
            raise ParseError(pending[0], "unattached description")
        return node('file', declarations[0].token if declarations else Token('EOF', '', 1, 1, '<input>'), declarations=declarations)

    def _package_body(self, lines, token):
        imports, sections, expected = [], [], ['Given', 'When', 'Then']
        def parse_item(line):
            c = Cursor(line.tokens); head = c.peek()
            if head.text == 'use':
                if sections:
                    c.fail("imports must precede Given", head)
                value = self._import(line); imports.append(value)
                return value
            if head.text not in expected:
                c.fail("expected package import or " + (expected[0] if expected else "end of package"), head)
            if not expected or head.text != expected[0]:
                c.fail("sections must appear once in Given/When/Then order", head)
            c.take(); self._end(c); expected.pop(0)
            declarations = self._described(line.children, lambda child: self._declaration(child, head.text))
            names = [value.data['name'] for value in declarations if value.kind == 'message']
            if len(names) != len(set(names)):
                c.fail('duplicate message name', head)
            if sum(value.kind == 'preferences' for value in declarations) > 1:
                c.fail('each owner may declare only one preferences schema', head)
            value = node('section', head, name=head.text, declarations=declarations)
            sections.append(value)
            return value
        self._described(lines, parse_item)
        if expected:
            raise ParseError(token, "package is missing " + '/'.join(expected))
        return {'imports': imports, 'sections': sections}

    def _import(self, line):
        self._leaf(line); c = Cursor(line.tokens); head = c.take('use'); provider = c.path()
        c.take('{'); members = []
        if c.at('}'):
            c.fail("an import must enumerate at least one member")
        while True:
            name = c.name(); alias = None
            if c.at('as'):
                c.take(); alias = c.name().text
            members.append(node('import_member', name, name=name.text, alias=alias))
            if not c.at(','): break
            c.take(',')
            if c.at('}'): break
        c.take('}'); attrs = self._attrs(c, {'from': 'path'})
        return node('import', head, provider=provider, members=members, attributes=attrs)

    def _context(self, line):
        c = Cursor(line.tokens); head = c.take('context'); self._end(c)
        if not line.children:
            c.fail("omit an empty context", head)
        declarations = self._described(line.children, self._context_decl)
        return node('context', head, declarations=declarations)

    def _context_decl(self, line):
        self._leaf(line); c = Cursor(line.tokens); head = c.take()
        if head.text == 'locale':
            attrs = self._attrs(c, {'default': 'string'}, ('default',))
            return node('locale', head, attributes=attrs)
        if head.text == 'theme':
            attrs = self._attrs(c, {'mode': 'name', 'accent': 'name', 'density': 'name'})
            if not attrs: c.fail("theme must declare a setting difference", head)
            return node('theme', head, attributes=attrs)
        if head.text == 'files':
            attrs = self._attrs(c, {'types': 'string', 'max': 'expr'})
            if not attrs: c.fail("files must declare a policy difference", head)
            return node('files', head, attributes=attrs)
        if head.text == 'binding':
            name = c.name(); c.take('DurableObject')
            attrs = self._attrs(c, {'key': 'path'}, ('key',))
            return node('binding', head, name=name.text, attributes=attrs)
        if head.text == 'queue':
            name = c.name(); attrs = self._attrs(c, {'type': 'type'}, ('type',))
            return node('queue', head, name=name.text, attributes=attrs)
        if head.text == 'cache':
            c.take('KV'); attrs = self._attrs(c, {'ttl': 'expr'}, ('ttl',))
            return node('cache', head, provider='KV', attributes=attrs)
        if head.text == 'analytics':
            name = c.name(); fields = c.fields(); self._end(c)
            return node('analytics', head, name=name.text, fields=fields)
        c.fail("unsupported context declaration; omit unchanged runtime/auth/database/teams defaults", head)

    def _declaration(self, line, section):
        if section == 'Then':
            return self._ui(line, top=True)
        c = Cursor(line.tokens); exported = bool(c.at('export'))
        if exported: c.take()
        head = c.peek()
        model_shape = head.kind == 'NAME' and (c.peek(1).text in ('{', 'in') or (c.peek(1).text == 'at' and c.peek(2).text == '='))
        if section == 'When':
            if head.text == 'scenario': value = self._scenario(line, c)
            elif head.text == 'crud' and not exported: value = self._crud(line, c)
            else: c.fail("expected scenario or crud declaration", head)
        elif head.text == 'preferences' and c.peek(1).text == '{':
            if exported: c.fail('preferences cannot be exported', head)
            c.take(); fields = c.fields(); attrs = self._attrs(c, {'label': 'label'}); self._leaf(line)
            if not fields: c.fail('omit an empty preferences schema', head)
            value = node('preferences', head, fields=fields, attributes=attrs)
        elif not model_shape and head.text == 'message':
            value = self._message(line, c, exported)
        elif not model_shape and head.text in ('contract', 'event'):
            c.take(); name = c.name(); fields = c.fields()
            attrs = self._attrs(c, {'label': 'label'} if head.text == 'contract' else {}); self._leaf(line)
            value = node(head.text, head, name=name.text, fields=fields, attributes=attrs)
        elif not model_shape and head.text == 'role':
            c.take(); name = c.name(); attrs = self._attrs(c, {'label': 'label'}); self._leaf(line)
            value = node('role', head, name=name.text, attributes=attrs)
        elif not model_shape and head.text == 'capability':
            c.take(); name = c.name(); attrs = self._attrs(c, {'version': 'expr'}, ('version',))
            children = self._described(line.children, self._capability_member)
            if not children: c.fail("capability requires operations or events", head)
            value = node('capability', head, name=name.text, attributes=attrs, declarations=children)
        elif not model_shape and head.text == 'derive':
            c.take(); name = c.path()
            params = c.params() if c.at('(') else None
            c.take(':'); type_ = c.type(); c.take('='); expression = c.expr(stop={'label'})
            attrs = self._attrs(c, {'label': 'label'} if params is None else {}); self._leaf(line)
            value = node('derive', head, name=name, parameters=params, type=type_, expression=expression, attributes=attrs)
        elif not model_shape and head.text == 'fixture':
            c.take(); name = c.name(); c.take('='); model = c.path(); recipe = c.object(); self._end(c); self._leaf(line)
            value = node('fixture', head, name=name.text, model=model, value=recipe)
        elif not model_shape and head.text in ('policy', 'lock', 'unique', 'retain'):
            if exported: c.fail("this declaration cannot be exported", head)
            c.take(); model = c.path()
            allowed = {
                'policy': {'read': 'expr', 'where': 'expr', 'fields': 'selectors'},
                'lock': {'fields': 'selectors', 'when': 'expr'},
                'unique': {'fields': 'selectors', 'where': 'expr'},
                'retain': {'until': 'expr'},
            }[head.text]
            required = {'policy': ('read',), 'lock': ('fields',), 'unique': ('fields',), 'retain': ('until',)}[head.text]
            attrs = self._attrs(c, allowed, required); self._leaf(line)
            value = node(head.text, head, model=model, attributes=attrs)
        elif not model_shape and head.text == 'invariant':
            if exported: c.fail("invariants cannot be exported", head)
            c.take(); model = c.path(); c.take(':'); expression = c.expr(); self._end(c); self._leaf(line)
            value = node('invariant', head, model=model, expression=expression)
        else:
            # Models are selected by their written declaration shape, not letter case.
            name = c.name(); parent = None; binding = None
            if c.at('in'):
                c.take(); parent = c.path()
                if parent.data.get('parts') == ['team']:
                    c.fail("omit redundant in team ownership", name)
            if c.at('at'):
                c.take(); c.take('='); binding = c.path()
            if not c.at('{'):
                c.fail("expected a model field schema", c.peek())
            fields = c.fields(); attrs = self._attrs(c, {'label': 'label'}); self._leaf(line)
            value = node('model', name, name=name.text, parent=parent, binding=binding, fields=fields, attributes=attrs)
        if exported:
            if value.kind == 'scenario' and value.data.get('handler'):
                c.fail("trusted handlers cannot be exported", head)
            if value.kind == 'derive' and value.data['parameters'] is None:
                c.fail("derived fields travel with their owning model; only derived functions are exported", head)
            value.data['exported'] = True
        return value

    def _message(self, line, c, exported):
        self._leaf(line); head = c.take("message"); name = c.name(); parameters = []
        if c.at("("):
            parameters = c.params()
            if not parameters:
                c.fail("omit an empty message parameter list", name)
        c.take("="); value = c.caption()
        if value.kind != "message_value":
            c.fail("named message requires an inline descriptor suffix", value.token)
        self._end(c)
        return node("message", head, name=name.text, parameters=parameters, value=value, exported=exported)

    def _capability_member(self, line):
        self._leaf(line); c = Cursor(line.tokens); head = c.peek()
        if head.text == 'event' and c.peek(1).kind == 'NAME' and c.peek(2).text == '{':
            c.take(); name = c.name(); fields = c.fields(); self._end(c)
            return node('event', head, name=name.text, fields=fields)
        name = c.name(); params = c.params(); c.take('->'); result = c.type(); self._end(c)
        return node('capability_operation', name, name=name.text, parameters=params, result=result)

    def _crud(self, line, c):
        head = c.take('crud'); model = c.path()
        allowed = {'by': 'expr', 'fields': 'selectors', 'create_fields': 'selectors', 'when': 'expr', 'create': 'name', 'update': 'name', 'delete': 'name', 'label': 'crud_label'}
        attrs = self._attrs(c, allowed, ('by', 'fields'))
        examples = self._described(line.children, lambda child: self._examples(child, crud=True))
        return node('crud', head, model=model, attributes=attrs, examples=examples)

    def _scenario(self, line, c):
        head = c.take('scenario'); name = c.name(); parameters = c.params() if c.at('(') else None
        attrs, result = {}, None
        allowed = {'by', 'on', 'read', 'scope', 'label'}
        while not c.done():
            if c.at('->'):
                arrow = c.take()
                if result is not None: c.fail("duplicate result type", arrow)
                result = c.type(); continue
            key = c.name()
            if key.text not in allowed: c.fail("unsupported scenario attribute " + key.text, key)
            if key.text in attrs: c.fail("duplicate scenario attribute " + key.text, key)
            c.take('=')
            if key.text == 'label': attrs[key.text] = c.label()
            elif key.text == 'read':
                true = c.take('true'); attrs[key.text] = node('literal', true, value=True)
            elif key.text == 'scope': attrs[key.text] = c.take('authority').text
            elif key.text == 'on' and not (c.at('every') and c.peek(1).text == '('):
                attrs[key.text] = c.path()
            else: attrs[key.text] = c.expr(stop=allowed | {'->'})
        handler = 'on' in attrs
        if handler:
            if 'label' in attrs:
                c.fail("trusted handlers do not declare operation labels", attrs['label'].token)
            source = attrs['on']
            periodic = (source.kind == 'call' and source.data['callee'].kind == 'name'
                        and source.data['callee'].data['name'] == 'every'
                        and len(source.data['arguments']) == 1
                        and source.data['arguments'][0].data['name'] is None
                        and source.data['arguments'][0].data['value'].kind == 'literal'
                        and source.data['arguments'][0].data['value'].data.get('literal_type') == 'duration')
            if source.kind != 'path' and not periodic:
                c.fail("handler source must be a path or every(duration literal)", source.token)
        if ('by' in attrs) == handler:
            c.fail("scenario requires exactly one of by or on", head)
        if handler and (parameters is not None or result is not None or 'read' in attrs or 'scope' in attrs):
            c.fail("trusted handlers declare no client parameters, result or read attributes", head)
        if not handler and parameters is None:
            c.fail("a user scenario requires a typed parameter list", name)
        if 'read' in attrs and result is None:
            c.fail("a read scenario requires a result type", name)
        if 'scope' in attrs and 'read' not in attrs:
            c.fail("scope=authority requires read=true", name)
        guards, execution, examples = self._execution_parts(line.children, head)
        return node('scenario', head, name=name.text, parameters=parameters, attributes=attrs, result=result, handler=handler, guards=guards, body=execution, examples=examples)

    def _execution_parts(self, lines, head, mapper=False):
        guards, body, examples = [], None, []
        for line in lines:
            c = Cursor(line.tokens)
            if c.peek().kind == 'DESC':
                c.fail("description metadata cannot attach to a guard, effect or example; use ##", c.peek())
            if c.at('require') and body is None:
                for piece in self._split(line):
                    guard = self._statement(Line(line.indent, piece, line.children), mapper=mapper)
                    if guard.kind != 'require': c.fail("only leading require guards are permitted before do")
                    guards.append(guard)
            elif c.at('do'):
                if body is not None or examples: c.fail("exactly one do body must precede examples")
                c.take()
                if c.done():
                    if not line.children: c.fail("block do requires statements", head)
                    body = self._statements(line.children, mapper=mapper)
                else:
                    self._leaf(line)
                    inline = Line(line.indent, line.tokens[1:], [])
                    body = self._statements([inline], mapper=mapper)
            elif c.at('examples') and body is not None and not mapper:
                examples.append(self._examples(line))
            else:
                c.fail("expected leading require, one do body, then examples")
        if body is None: raise ParseError(head, "execution declaration requires one do body")
        return guards, body, examples

    def _statements(self, lines, mapper=False):
        output = []; i = 0
        while i < len(lines):
            line = lines[i]
            if line.tokens[0].kind == 'DESC':
                raise ParseError(line.tokens[0], "description metadata cannot attach to execution statements; use ##")
            pieces = self._split(line)
            if len(pieces) > 1 and any(p[0].text in ('if', 'for', 'else', 'do') for p in pieces):
                raise ParseError(line.tokens[0], "compound statements require their own indented block")
            for piece in pieces:
                child = Line(line.indent, piece, line.children)
                value = self._statement(child, mapper=mapper)
                if value.kind == 'if' and i+1 < len(lines) and lines[i+1].tokens[0].text == 'else':
                    following = lines[i+1]; ec = Cursor(following.tokens); ec.take('else'); self._end(ec)
                    if not following.children: ec.fail("else requires an indented body")
                    value.data['else_body'] = self._statements(following.children, mapper=mapper); i += 1
                output.append(value)
            i += 1
        return output

    def _statement(self, line, mapper=False):
        c = Cursor(line.tokens); head = c.take()
        if mapper and head.text not in ('let', 'require', 'if', 'set'):
            c.fail("migration mapper permits only let, require, if/else and set row", head)
        if head.text == 'if':
            condition = c.expr(); self._end(c)
            if not line.children: c.fail("if requires an indented body", head)
            return node('if', head, condition=condition, body=self._statements(line.children, mapper=mapper), else_body=[])
        if head.text == 'for':
            name = c.name(); c.take('in'); query = c.expr(stop={'limit'}); c.take('limit'); c.take('='); limit = c.expr(); self._end(c)
            if not line.children: c.fail("for requires an indented body", head)
            return node('for', head, name=name.text, query=query, limit=limit, body=self._statements(line.children))
        self._leaf(line)
        if head.text == 'let':
            name = c.name(); c.take('='); expression = c.expr(); value = node('let', head, name=name.text, expression=expression)
        elif head.text == 'require':
            expression = c.expr(stop={'message'}); attrs = self._attrs(c, {'message': 'expr'})
            value = node('require', head, expression=expression, attributes=attrs)
        elif head.text in ('create', 'set', 'emit'):
            target = c.path()
            if mapper and target.data.get('parts') != ['row']:
                c.fail("migration assignment target must be row", head)
            fields = c.object(); name = None
            if head.text == 'create': c.take('as'); name = c.name().text
            value = node(head.text, head, target=target, value=fields, name=name)
        elif head.text in ('call', 'send'):
            target = c.expr(stop={'{'}, query=False, construct=False); arguments = c.object(); attrs = {}; name = None
            if head.text == 'send' and c.at('when'):
                c.take(); c.take('='); attrs['when'] = c.expr(stop={'as'}, query=False)
            if c.at('as'): c.take(); name = c.name().text
            if head.text == 'send' and name is None: c.fail("send requires a delivery binding")
            value = node(head.text, head, target=target, arguments=arguments, attributes=attrs, name=name)
        elif head.text == 'schedule':
            key = c.expr(stop={'at', 'event'}); c.take('at'); c.take('='); instant = c.expr(stop={'event'}); c.take('event'); c.take('='); event = c.path(); fields = c.object()
            value = node('schedule', head, key=key, at=instant, event=event, value=fields)
        elif head.text == 'delete':
            value = node('delete', head, expression=c.path())
        elif head.text in ('cancel', 'return'):
            expression = c.expr(); value = node(head.text, head, expression=expression)
        else:
            c.fail("unsupported execution statement " + head.text, head)
        self._end(c); return value

    def _examples(self, line, crud=False):
        c = Cursor(line.tokens); head = c.take('examples'); operation = None
        if crud:
            operation = c.name().text
            if operation not in ('create', 'update', 'delete'): c.fail("CRUD examples require create, update or delete", head)
        bindings = {}
        while not c.done():
            key = c.name(); c.take('=')
            if key.text in bindings: c.fail("duplicate example binding", key)
            begin = c.i; depth = 0
            while not c.done():
                token = c.peek()
                if depth == 0 and token.kind == 'NAME' and c.peek(1).text == '=':
                    break
                if token.text in ('(', '[', '{'): depth += 1
                elif token.text in (')', ']', '}'): depth -= 1
                c.take()
            value_cursor = Cursor(c.tokens[begin:c.i])
            bindings[key.text] = value_cursor.expr()
            self._end(value_cursor)
        if len(line.children) < 2:
            c.fail("examples require one header and at least one row", head)
        def table_row(child):
            self._leaf(child); rc = Cursor(child.tokens)
            left = self._expression_list(rc, stop={'->'}); rc.take('->')
            right = self._expression_list(rc); self._end(rc)
            return node('example_row', child.tokens[0], inputs=left, observations=right)
        rows = [table_row(child) for child in line.children]
        def is_error(value):
            return value.kind == 'call' and value.data['callee'].kind == 'name' and value.data['callee'].data['name'] == 'error'
        for row in rows[1:]:
            if len(row.data['inputs']) != len(rows[0].data['inputs']):
                raise ParseError(row.token, 'example input row does not match header arity')
            errors = [value for value in row.data['observations'] if is_error(value)]
            if errors:
                if len(row.data['observations']) != 1 or len(errors[0].data['arguments']) != 1:
                    raise ParseError(row.token, 'error(code) must replace the entire expected row')
            elif len(row.data['observations']) != len(rows[0].data['observations']):
                raise ParseError(row.token, 'example expected row does not match header arity')
        return node('examples', head, operation=operation, bindings=bindings, header=rows[0], rows=rows[1:])

    def _expression_list(self, c, stop=None):
        values = [c.expr(stop=set(stop or ()))]
        while c.at(','):
            c.take(','); values.append(c.expr(stop=set(stop or ())))
        return values

    def _route(self, c, stop):
        begin = c.i
        start = c.take('/'); segments = []
        def ended():
            return c.done() or (c.peek().text in stop and c.peek(1).text == '=')
        while not ended():
            if c.at('/'):
                c.fail("route segments cannot be empty")
            if c.at('{'):
                brace = c.take(); name = c.path()
                if c.at(':'):
                    if len(name.data.get('parts', [])) != 1: c.fail("scalar route parameter must have one name", brace)
                    c.take(); type_ = c.type(); segment = node('route_scalar', brace, name=name, type=type_)
                else:
                    if len(name.data.get('parts', [])) < 2 or name.data['parts'][-1] != 'id':
                        c.fail("record route parameter must name Model.id", brace)
                    segment = node('route_record', brace, model=name)
                c.take('}'); segments.append(segment)
            else:
                current = ''
                while not ended() and not c.at('/'):
                    token = c.take()
                    if (token.kind not in ('NAME', 'NUMBER') and token.text != '-') or not re.fullmatch(r'[A-Za-z0-9_-]+', token.text):
                        c.fail("invalid static route segment", token)
                    current += token.text
                segments.append(current)
            if ended(): break
            c.take('/')
            if ended(): c.fail("only the root route may end in /", c.tokens[c.i-1])
        tokens = c.tokens[begin:c.i]
        for previous, following in zip(tokens, tokens[1:]):
            if following.line != previous.line or following.column != previous.column + len(previous.text):
                c.fail('route syntax must be contiguous on one physical line', following)
        return node('route', start, segments=segments)

    def _ui(self, line, top=False, tabs=False):
        c = Cursor(line.tokens); head = c.take()
        collection_attrs = {'order': 'selectors', 'search': 'selectors', 'filter': 'selectors', 'columns': 'selectors', 'empty': 'expr', 'defaults': 'object'}
        if top and head.text != 'page': c.fail("Then accepts pages; navigation derives from them", head)
        if tabs and head.text != 'tab': c.fail("tabs accepts tab suites", head)
        if not top and head.text == 'page':
            c.fail('page declarations belong directly in Then', head)
        if not tabs and head.text == 'tab':
            c.fail('tab belongs directly inside tabs', head)
        if head.text == 'page':
            allowed = {'title': 'expr', 'data': 'expr', 'order': 'expr', 'group': 'expr', 'nav': 'name'}
            route = self._route(c, set(allowed)); attrs = self._attrs(c, allowed, ('title',))
            value = node('page', head, route=route, attributes=attrs)
        elif head.text == 'tabs':
            selector = None if c.done() else c.expr()
            self._end(c)
            if not line.children and selector is None: c.fail('unbound tabs requires tab suites', head)
            return node('tabs', head, selector=selector,
                        children=self._described(line.children, lambda child: self._ui(child, tabs=True)))
        elif head.text == 'tab':
            caption = c.expr(); self._end(c)
            if not line.children: c.fail('tab requires presentation children', head)
            return node('tab', head, caption=caption, children=self._described(line.children, self._ui))
        elif head.text in ('list', 'table', 'board', 'calendar'):
            allowed = dict(collection_attrs)
            if head.text in ('list', 'table'): allowed['display'] = 'name'
            if head.text == 'board': allowed['by'] = 'selectors'
            if head.text == 'calendar': allowed.update({'start': 'selectors', 'end': 'selectors'})
            required = {'table': ('columns',), 'board': ('by',), 'calendar': ('start', 'end')}.get(head.text, ())
            expression = c.expr(stop=set(allowed)); attrs = self._attrs(c, allowed, required)
            value = node(head.text, head, query=expression, attributes=attrs)
        elif head.text == 'form':
            allowed = {'fields': 'selectors', 'arguments': 'object', 'submit': 'expr', 'display': 'name'}
            operation = c.expr(stop=set(allowed)); attrs = self._attrs(c, allowed)
            value = node('form', head, operation=operation, attributes=attrs)
        elif head.text == 'edit':
            attrs = self._attrs(c, {'fields': 'selectors'}); self._leaf(line)
            value = node('edit', head, attributes=attrs)
        elif head.text in ('delete', 'history'):
            self._end(c); self._leaf(line); value = node(head.text, head)
        elif head.text in ('action', 'actions'):
            expressions = self._expression_list(c); self._end(c); self._leaf(line)
            if head.text == 'action' and len(expressions) != 1: c.fail("action requires one operation", head)
            value = node(head.text, head, operations=expressions)
        elif head.text in ('text', 'content', 'metrics'):
            expressions = self._expression_list(c); self._end(c); self._leaf(line)
            value = node(head.text, head, expressions=expressions)
        elif head.text in ('title', 'copy'):
            expression = c.expr(); self._end(c); self._leaf(line)
            value = node(head.text, head, expression=expression)
        elif head.text in ('card', 'details'):
            allowed = {'layout': 'name'} if head.text == 'card' else {'display': 'name', 'open': 'expr'}
            heading = c.expr(stop=set(allowed)); attrs = self._attrs(c, allowed)
            if head.text == 'details' and 'display' in attrs and 'open' in attrs:
                c.fail('drawer details cannot declare open; open applies to Collapse', head)
            value = node(head.text, head, heading=heading, attributes=attrs)
        elif head.text == 'require':
            expression = c.expr(); self._end(c); self._leaf(line)
            value = node('require', head, expression=expression)
        else:
            c.fail("unsupported presentation primitive " + head.text, head)
        self._end(c)
        if line.children:
            if head.text not in ('page', 'list', 'table', 'board', 'calendar', 'form', 'card', 'details'):
                c.fail("this presentation primitive cannot own children", head)
            value.data['children'] = self._described(line.children, self._ui)
        else:
            if head.text in ('card', 'details'): c.fail("presentation group requires children", head)
            value.data['children'] = []
        return value

    def _migration(self, line):
        c = Cursor(line.tokens); head = c.take('migration'); owner = c.name()
        attrs = self._attrs(c, {'from': 'string'}, ('from',))
        declarations = self._described(line.children, self._migration_directive)
        return node('migration', head, owner=owner.text, attributes=attrs, directives=declarations)

    def _migration_directive(self, line):
        c = Cursor(line.tokens); head = c.take()
        if head.text == 'backfill':
            model = c.path(); self._end(c)
            if len(model.data.get('parts', [])) != 1:
                c.fail('backfill names one desired model', head)
            guards, body, examples = self._execution_parts(line.children, head, mapper=True)
            return node('backfill', head, model=model, guards=guards, body=body)
        self._leaf(line)
        if head.text in ('rename', 'drop'):
            if c.at('owner') and c.peek(1).text not in ('.', 'to'):
                c.take(); self._end(c); return node(head.text, head, owner=True)
            before = c.path()
            if not before.data.get('parts') or before.data['parts'][0] != 'before':
                c.fail("migration source must be in before namespace", head)
            if len(before.data['parts']) not in (2, 3):
                c.fail('migration source must name before.Model or before.Model.field', head)
            target = None
            if head.text == 'rename':
                c.take('to'); target = c.path()
                if len(target.data['parts']) != len(before.data['parts']) - 1:
                    c.fail('rename must map a model to a model or a field to a field', head)
            self._end(c); return node(head.text, head, source=before, target=target)
        if head.text == 'invalidate':
            before = c.path(); self._end(c)
            if len(before.data.get('parts', [])) != 2 or before.data['parts'][0] != 'before':
                c.fail("invalidate requires before.handler", head)
            return node('invalidate', head, source=before)
        c.fail("unsupported migration directive", head)


def parse(source: str, path: str = "<input>") -> Node:
    lines = layout(lex(source, path))
    if not lines:
        return node("file", Token("EOF", "", 1, 1, path), declarations=[])
    return Parser(lines).parse()


def main(argv=None):
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument("sources", nargs="+", type=Path, help=".can files or directories to inspect")
    cli.add_argument("--json", action="store_true", help="print located syntax ASTs")
    args = cli.parse_args(argv)
    paths = set()
    for source in args.sources:
        paths.update(source.rglob("*.can") if source.is_dir() else [source])
    if not paths:
        cli.error("no .can sources found")
    trees, failed = [], False
    for path in sorted(paths):
        try:
            trees.append(parse(path.read_bytes().decode("utf-8"), str(path)))
        except (OSError, UnicodeError) as error:
            print(f"{path}:1:1: input: {error}", file=sys.stderr)
            failed = True
        except ParseError as error:
            print(error, file=sys.stderr)
            failed = True
    if args.json:
        print(json.dumps([tree.to_dict() for tree in trees], indent=2))
    elif not failed:
        print(f"Parsed {len(trees)} .can files (syntax only).")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
