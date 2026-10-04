"""Syntax boundary tests; these do not execute canlang business examples."""

from pathlib import Path
import unittest

from can_parser import ParseError, parse


ROOT = Path(__file__).resolve().parents[1]


def app(given="", when="", then=""):
    return "# Test application.\napp Test\nGiven\n" + given + "When\n" + when + "Then\n" + then


def operation(body, guards=""):
    return app(" Thing {value:int, values:int[], active:bool=true}\n",
               " # Change test work.\n scenario change(thing:Thing) by=members\n" + guards + body)


def expression(value):
    return app(" derive value():int = " + value + "\n")


class CanParserTests(unittest.TestCase):
    def accepted(self, source):
        result = parse(source, path="boundary.can")
        self.assertTrue(hasattr(result, "kind"))
        return result

    def rejected(self, source):
        with self.assertRaises(ParseError) as caught:
            parse(source, path="boundary.can")
        error = caught.exception
        token = getattr(error, "token", None)
        line = getattr(error, "line", getattr(token, "line", None))
        column = getattr(error, "column", getattr(token, "column", None))
        self.assertIsInstance(line, int)
        self.assertIsInstance(column, int)
        self.assertGreaterEqual(line, 1)
        self.assertGreaterEqual(column, 1)
        return error

    def test_small_app_and_inline_operation(self):
        self.accepted(app(" Todo {title:text trim max=200, done:bool=false}\n policy Todo read=members\n",
                          " crud Todo by=members fields=title,done\n # Finish the task.\n"
                          " scenario finish(todo:Todo) by=members\n  require not todo.done\n"
                          "  do set todo {done=true}\n",
                          " page / title=\"Tasks\"\n  form Todo.create display=inline\n"
                          "  list Todo order=-created,id search=title filter=done\n   edit\n   delete\n"))

    def test_owned_preferences_shape_and_contextual_names(self):
        tree = self.accepted(app(' preferences {view:enum(all,today)=all, location:Location?, history_open:bool=false}\n'
                                 ' invariant preferences: row.location==null or allowed(row.location)\n'
                                 ' Thing {preferences:text, tabs:text}\n'))
        declarations = tree.data['declarations'][0].data['sections'][0].data['declarations']
        self.assertEqual(declarations[0].kind, 'preferences')
        self.assertEqual(declarations[0].data['fields'][0].data['name'], 'view')
        for given in (' preferences {}\n', ' export preferences {view:bool=false}\n',
                      ' preferences Named {view:bool=false}\n',
                      ' preferences {view:bool=false}\n preferences {other:bool=true}\n'):
            with self.subTest(given=given):
                self.rejected(app(given))

    def test_given_invariant_spelling_structure_and_semicolon_leaves(self):
        tree = self.accepted(app(' Thing {value:int}\n'
                                 ' # Positive values.\n'
                                 ' invariant Test.Thing: row.value>0; invariant Thing: row.value<10\n'))
        declarations = tree.data['declarations'][0].data['sections'][0].data['declarations']
        first, second = declarations[1:]
        self.assertEqual((first.kind, second.kind), ('invariant', 'invariant'))
        self.assertEqual(first.token.text, 'invariant')
        self.assertEqual(first.data['model'].data['parts'], ['Test', 'Thing'])
        self.assertEqual(second.data['model'].data['parts'], ['Thing'])
        predicate = first.data['expression']
        self.assertEqual((predicate.kind, predicate.data['operator']), ('binary', '>'))
        self.assertEqual(predicate.data['left'].data['receiver'].data['name'], 'row')
        self.assertEqual(predicate.data['left'].data['name'], 'value')
        self.assertIn('description', first.data)
        for given in (' require Thing: row.value>0\n',
                      ' invariant Thing: row.value>0; require Thing: row.value<10\n',
                      ' export invariant Thing: row.value>0\n',
                      ' invariant Thing row.value>0\n',
                      ' invariant Thing: row.value>0\n  Thing {value:int}\n'):
            with self.subTest(given=given):
                self.rejected(app(given))

    def test_require_and_invariant_remain_contextual_names(self):
        tree = self.accepted(app(' require {invariant:int, require:int}\n'
                                 ' invariant {require:int, invariant:int}\n'
                                 ' message require="Required"@{}; message invariant="Valid"@{}\n'
                                 ' derive require(invariant:int,require:int):int=invariant+require\n'
                                 ' derive invariant(require:int):int=require\n'
                                 ' invariant require: row.invariant>=row.require\n',
                                 ' scenario invariant(require:require,invariant:invariant) by=members\n'
                                 '  require require.invariant>0\n'
                                 '  do let invariant=require.invariant; let require=invariant\n'))
        declarations = tree.data['declarations'][0].data['sections'][0].data['declarations']
        self.assertEqual([item.data['name'] for item in declarations[:4]],
                         ['require', 'invariant', 'require', 'invariant'])
        self.assertEqual(declarations[-1].data['model'].data['parts'], ['require'])

    def test_non_given_require_keeps_its_guard_and_gate_spelling(self):
        self.accepted(app(' Thing {value:int}\n',
                          ' scenario change(thing:Thing) by=members\n'
                          '  require thing.value>0\n'
                          '  do require thing.value<10; set thing {value=2}\n',
                          ' page / title="Work"\n  require true\n  text "Available"\n') +
                      'migration Test from="snapshot"\n backfill Thing\n'
                      '  require before.value>0\n  do require before.value<10; set row {value=before.value}\n')
        self.rejected(operation('  do invariant thing.value>0\n'))
        self.rejected(app(then=' page / title="Work"\n  invariant true\n'))

    def test_owned_caption_and_case_labels(self):
        tree = self.accepted(app(' message heading="Work"@{nl="Werk"}\n'
                                 ' Thing {state:enum(open,done)=open label={text="State"@{nl="Status"},'
                                 'values={open=heading,done="Done"@{nl="Klaar"}}}} label=heading\n'
                                 ' preferences {view:enum(all,today)=all label={values={all=heading,today="Today"@{}}}} label=heading\n'
                                 ' role reviewer label="Reviewer"@{nl="Beoordelaar"}\n'
                                 ' contract Result {value:int label="Value"@{nl="Waarde"}} label=heading\n'
                                 ' derive Thing.caption:text=row.title label=heading\n',
                                 ' crud Thing by=members fields=state label={create=heading,update="Update"@{}}\n'
                                 ' scenario finish(thing:Thing label=heading) by=members label=heading\n'
                                 '  do set thing {state=done}\n'))
        sections = tree.data['declarations'][0].data['sections']
        model = sections[0].data['declarations'][1]
        self.assertEqual(model.data['attributes']['label'].kind, 'path')
        label = model.data['fields'][0].data['attributes']['label']
        self.assertEqual(label.kind, 'label')
        self.assertEqual([case.data['name'] for case in label.data['values']], ['open', 'done'])
        self.assertEqual(sections[1].data['declarations'][0].data['attributes']['label'].kind, 'crud_labels')
        for declaration in (' Thing {value:int label={}}\n',
                            ' Thing {value:int label={values={}}}\n',
                            ' Thing {value:int label={other="Bad"}}\n',
                            ' Thing {value:int label={text="One",text="Two"}}\n',
                            ' Thing {value:bool label={values={true="One",true="Two"}}}\n',
                            ' Thing {value:int} label={text="Bad"}\n',
                            ' role reviewer label=caption()\n',
                            ' event Changed {value:int} label="Changed"\n',
                            ' derive caption():text="Text" label="Caption"\n',
                            ' Thing {value:int label="Good" min=0}\n'):
            with self.subTest(declaration=declaration):
                self.rejected(app(declaration))
        for labels in ('"Bad"', '{}', '{remove="Bad"}', '{create="One",create="Two"}'):
            with self.subTest(labels=labels):
                self.rejected(app(when=' crud Thing by=members fields=value label='+labels+'\n'))
        self.rejected(app(when=' scenario changed on=Thing.created label="Changed"\n  do let value=1\n'))

    def test_tabs_details_filter_defaults_and_derived_navigation(self):
        self.accepted(app(then=' page /work title=heading order=2 group=group_heading nav=none\n'
                          '  tabs preferences.view\n'
                          '  table Work columns=title filter=location defaults={location=preferences.location} display=split\n'
                          '   details record_heading display=drawer\n    form complete\n'
                          '   details activity_heading open=preferences.history_open\n    history\n'
                          '  tabs\n   tab messages_heading\n    text row.body\n'
                          '   tab notes_heading\n    form note\n'
                          '  tabs preferences.view\n   tab all\n    list Work\n'
                          '   tab today\n    list Work\n'))
        for body in ('  tabs\n', '  tab "Orphan"\n   text "Work"\n',
                     '  tabs\n   text "Missing tab suite"\n',
                     '  tabs\n   tab "Empty"\n',
                     '  details "Work" display=drawer open=true\n   history\n',
                     '  board Work by=state display=split\n',
                     '  details "Work" layout=columns\n   history\n'):
            with self.subTest(body=body):
                self.rejected(app(then=' page / title="Work"\n'+body))
        self.rejected(app(then=' nav\n  link "Work" to=/work\n'))

    def test_empty_sections_multiple_implicit_apps_and_composition(self):
        self.accepted("# First.\napp First\nGiven\nWhen\nThen\n"
                      "# Second.\napp Second\nGiven\nWhen\nThen\n"
                      "# Together.\napp Both uses=[First,Second]\n")

    def test_package_only_dependency_and_grouped_bound_import(self):
        self.accepted("package local\n use provider {Thing,Other as Alias} from=deployment.work\n"
                      " Given\n When\n Then\n")

    def test_contextual_names_named_arguments_and_field_type_reuse(self):
        self.accepted(app(" contract Times {from:datetime, end:datetime, rows:text[]}\n"
                          " Thing {from:Times.from, end:Times.end, rows:Times.rows!}\n"
                          " derive from(end:date):datetime = local_instant(end,\"00:00\",zone,fold=earlier)\n"))

    def test_flat_array_nullable_required_and_union_types(self):
        self.accepted(app(" contract A {name:text}\n contract B {name:text}\n"
                          " Thing {optional:text[]?, required:text[]!, choice:A|B, rows:Unknown.rows!}\n"))

    def test_descriptions_and_comments_within_multiline_fields(self):
        self.accepted(app(" # Stored work.\n\n ## Intervening ignored comment.\n Thing {\n"
                          "  # Field supporting text.\n  title:text,\n"
                          "  ## Not field metadata.\n  detail:text?\n }\n"))

    def test_string_delimiters_and_json_escapes_are_not_syntax(self):
        self.accepted(app(' Thing {title:text="a,b;#[]{}()\\n\\\"quote\\\""}\n',
                          then=' page / title="# {not syntax}, ;"\n'))

    def test_nested_queries_aggregate_domains_and_struct_shorthand(self):
        self.accepted(expression(
            "sum([from]+(resource.Booking as b where b.active order=-b.created "
            "select b.from) as point select count(resource.Booking as b where b.from<=point))"))
        self.accepted(operation("  do\n   let groups=group(selected as day,day.year)\n"
                                "   for year in groups limit=10\n"
                                "    create Thing {value=count(year.items)} as made\n"))

    def test_operator_grouping_nullable_access_and_literal_units(self):
        for value in ("(row.until ?? now)-row.from", "event.result?.source==revision.id and event.result.ready",
                      "a ?? b ?? c", "not a==b or c and d", "1h+30m", "20MiB", "-0.1*2+3"):
            with self.subTest(expression=value):
                self.accepted(expression(value))

    def test_ast_arithmetic_precedence_and_right_associative_fallback(self):
        tree = self.accepted(expression("a+b*c ?? d ?? e"))
        value = tree.data["declarations"][0].data["sections"][0].data["declarations"][0].data["expression"]
        self.assertEqual((value.kind, value.data["operator"]), ("binary", "??"))
        self.assertEqual(value.data["left"].data["operator"], "+")
        self.assertEqual(value.data["left"].data["right"].data["operator"], "*")
        self.assertEqual(value.data["right"].data["operator"], "??")
        self.assertEqual(value.data["right"].data["left"].data["name"], "d")

    def test_ast_query_domain_alias_and_projection_are_distinct(self):
        tree = self.accepted(expression("Thing as item where item.active order=-item.created select item.value"))
        query = tree.data["declarations"][0].data["sections"][0].data["declarations"][0].data["expression"]
        self.assertEqual(query.kind, "query")
        self.assertEqual(query.data["domain"].data["name"], "Thing")
        self.assertEqual(query.data["alias"], "item")
        self.assertEqual(set(query.data["clauses"]), {"where", "order", "select"})
        self.assertEqual(query.data["clauses"]["select"].data["name"], "value")
        self.assertEqual(query.data["clauses"]["order"].data["operator"], "-")

    def test_ast_field_type_path_and_required_array_marker(self):
        tree = self.accepted(app(" Thing {rows:Unknown.rows!}\n"))
        field = tree.data["declarations"][0].data["sections"][0].data["declarations"][0].data["fields"][0]
        self.assertEqual(field.kind, "field")
        self.assertEqual(field.data["type"].kind, "named_type")
        self.assertEqual(field.data["type"].data["names"][0].data["parts"], ["Unknown", "rows"])
        self.assertTrue(field.data["required_array"])

    def test_semicolons_and_nested_compound_layout(self):
        self.accepted(operation("  do let a=1; set thing {value=a}\n"))
        self.accepted(operation("  do\n   if thing.active\n    for item in thing.values limit=100\n"
                                "     require item>0\n   else\n    set thing {value=0}\n"))

    def test_inline_examples_nested_cells_and_error_rows(self):
        self.accepted(app(" Thing {value:int}\n fixture one=Thing {value=1}\n",
                          " crud Thing by=members fields=value\n  examples update record=one\n"
                          "   as,changes.value -> record.value\n   members,2 -> 2\n"
                          "   public,2 -> error(forbidden)\n"))

    def test_documented_context_routes_and_ui_groups(self):
        self.accepted("# Service.\napp Test\ncontext\n theme mode=dark accent=green density=compact\n"
                      " files max=20MiB\n binding Store DurableObject key=Test.Thing\n"
                      " queue Jobs type=Test.Work\n cache KV ttl=5m\n"
                      " analytics Events {kind:text,value:decimal}\n"
                      "Given\n Thing at=Store {title:text}\n contract Work {title:text}\nWhen\nThen\n"
                      " page /redeem/{token:text} title=\"Redeem\" data=redeem(token=token)\n"
                      "  card \"Work\" layout=columns\n   details \"More\"\n    text result.title\n"
                      " page /things/{Thing.id} title=\"Thing\"\n  form update arguments={thing=row}\n")

    def test_migration_directives_and_pure_mapper(self):
        self.accepted(app(" Thing {value:int}\n") +
                      "# Move stored data.\nmigration Test from=\"snapshot\"\n"
                      " rename before.Old to Thing\n rename before.Old.number to Thing.value\n"
                      " backfill Thing\n  require before.number>=0\n  do\n"
                      "   let value=before.number\n   if value>0\n    set row {value}\n"
                      "   else\n    set row {value=0}\n"
                      " drop before.Old.unused\n invalidate before.old_handler\n")

    def test_closed_attribute_vocabularies(self):
        for source in ("# App.\napp Test mystery=true\nGiven\nWhen\nThen\n",
                       app(" Thing {value:int mystery=1}\n"),
                       app(" Thing {value:int}\n policy Thing write=members\n"),
                       app(when=" crud Thing by=members fields=value mystery=true\n"),
                       app(then=" page / title=\"Test\" mystery=true\n")):
            with self.subTest(source=source):
                self.rejected(source)

    def test_lexical_and_description_errors(self):
        for source in ("# App.\napp Test\nGiven\n\tThing {value:int}\nWhen\nThen\n",
                       app(" Thing {value:int\n"), app(' Thing {title:text="bad\\q"}\n'),
                       app(" # Unattached.\n"), app(" Thing {\n  # Unattached field.\n }\n")):
            with self.subTest(source=source):
                self.rejected(source)

    def test_expression_rejections(self):
        for value in ("a<b<c", "a==b==c", "a ?? b and c", "a or b ?? c",
                      "items[0]", "receiver?.call()", "function(key=1,2)",
                      "a+not b", "a==not b", "-not a"):
            with self.subTest(expression=value):
                self.rejected(expression(value))

    def test_statement_layout_and_body_rejections(self):
        for body in ("  do\n   else\n    set thing {value=1}\n",
                     "  do if thing.active\n   set thing {value=1}\n",
                     "  let value=1\n  do set thing {value}\n",
                     "  require thing.active\n",
                     "  do set thing {value=1}\n  do set thing {value=2}\n"):
            with self.subTest(body=body):
                self.rejected(operation(body))

    def test_migration_mapper_rejects_business_effects(self):
        for effect in ("create Thing {value=1} as made", "send Mail.send {to=address} as delivery",
                       "return 1", "for item in values limit=10\n    set row {value=item}"):
            with self.subTest(effect=effect):
                self.rejected(app(" Thing {value:int}\n") +
                              "migration Test from=\"snapshot\"\n backfill Thing\n  do\n   " + effect + "\n")

    def test_declaration_and_effect_structural_boundaries(self):
        accepted = [
            app(" page {value:int}; capability {value:int}\n"),
            app(" page {value:int}; capability {value:int}\n"),
            app(" Thing {title:text=\"new\" trim min=1, owner:user server=actor unique}\n"),
            app(" Thing {state:enum(from,end), next:action(local.finish,remote.finish)?}\n"),
            app(" export derive ready(value:bool):bool = value\n"),
            app(when=" scenario tick on=every(5ms)\n  do let value=1\n"),
            app(when=" scenario tick on=every(5ms,)\n  do let value=1\n"),
            app(when=" scenario hook on=Thing.created\n  do let value=1\n"),
            app(when=" scenario hook on=true.created\n  do let value=1\n"),
            operation("  do delete thing\n"),
            expression("Result {value=1}"),
        ]
        rejected = [
            app(" Thing {title:text trim=\"new\"}\n"),
            app(" Thing {title:text trim server=actor}\n"),
            app(" Thing {value:int min=0 server=actor}\n"),
            app(" Thing {state:enum(provider.open)}\n"),
            app(' Thing {state:enum("open")}\n'),
            app(" export derive Thing.ready:bool = true\n"),
            app(when=" scenario tick on=every(interval)\n  do let value=1\n"),
            app(when=" scenario tick on=every(5)\n  do let value=1\n"),
            app(when=" scenario tick on=every(5m,10m)\n  do let value=1\n"),
            app(when=" scenario hook on=source()\n  do let value=1\n"),
            operation("  do delete thing+other\n"),
            operation("  do delete select_record()\n"),
            expression("receiver?.Result {value=1}"),
        ]
        for source in accepted:
            with self.subTest(accepted=source):
                self.accepted(source)
        for source in rejected:
            with self.subTest(rejected=source):
                self.rejected(source)

    def test_ui_suite_and_route_boundaries(self):
        for route in ("/", "/work-items_v2/2026", "/things/{Thing.id}", "/redeem/{token:text}"):
            with self.subTest(route=route):
                self.accepted(app(then=f' page {route} title="Work"\n'))
        self.accepted(app(then=' page / title="Work"\n  card "Group"\n   details "More"\n    text "Hello"\n'))
        for then in (' nav\n', ' page / title="Work"\n  card "Empty"\n',
                     ' page / title="Work"\n  details "Empty"\n'):
            with self.subTest(empty_suite=then):
                self.rejected(app(then=then))
        for route in ("/work/", "/work//next", "/work.name", "/part{Thing.id}", "/{Thing.id}tail", "/{id}"):
            with self.subTest(invalid_route=route):
                self.rejected(app(then=f' page {route} title="Work"\n'))

    def test_numeric_literals_preserve_exact_syntax_and_reject_unsupported_forms(self):
        for spelling, kind, numeric, unit in (
                ("9007199254740993", "integer", "9007199254740993", None),
                ("0.100000000000000001", "decimal", "0.100000000000000001", None),
                ("5ms", "duration", "5", "ms"),
                ("20MiB", "bytes", "20", "MiB")):
            with self.subTest(literal=spelling):
                tree = self.accepted(expression(spelling))
                literal = tree.data["declarations"][0].data["sections"][0].data["declarations"][0].data["expression"]
                self.assertEqual(literal.kind, "literal")
                self.assertEqual(literal.data, {"value": numeric, "literal_type": kind, "unit": unit})
        for value in ("1.5h", "1.5MiB", "1e3", "5minutes"):
            with self.subTest(invalid_literal=value):
                self.rejected(expression(value))
        self.rejected(app().replace("Given\n", "Given\r"))

    def test_inline_message_descriptors_and_named_reuse(self):
        tree = self.accepted(app(' export message heading="Work"@{nl="Werk", "pt-BR"="Tarefas",de=null,}\n'
                                 ' message welcome(person:text)="Hello {person}"@{nl="Hallo {person}"}\n'
                                 ' message broken="{unfinished ICU"@{}; message source_only="Source"@{}\n'
                                 ' messages {value:int}; message {value:int}\n',
                                 then=' page / title="Tasks" @{nl="Taken"}\n'
                                      '  text "Literal {braces}","Hello {person}"@{nl="Hallo {person}"}(person=actor)\n'))
        named = tree.data['declarations'][0].data['sections'][0].data['declarations']
        heading, welcome, _, source_only = named[:4]
        self.assertEqual(heading.kind, 'message')
        self.assertTrue(heading.data['exported'])
        value = heading.data['value']
        self.assertEqual(value.kind, 'message_value')
        self.assertEqual(value.data['source'].data['value'], 'Work')
        self.assertEqual([variant.data['locale'] for variant in value.data['variants']], ['nl', 'pt-BR', 'de'])
        self.assertIsNone(value.data['variants'][2].data['value'].data['value'])
        self.assertEqual(welcome.data['parameters'][0].data['name'], 'person')
        self.assertEqual(source_only.data['value'].data['variants'], [])
        expressions = tree.data['declarations'][0].data['sections'][2].data['declarations'][0].data['children'][0].data['expressions']
        self.assertEqual(expressions[0].kind, 'literal')
        self.assertEqual(expressions[1].kind, 'call')
        self.assertEqual(expressions[1].data['arguments'][0].data['name'], 'person')
        # ICU validity, inferred argument types and provenance remain checker work.

    def test_inline_message_syntax_rejections(self):
        for given in (' messages "en","nl"\n  heading="Work","Werk"\n',
                      ' message title="Work"\n',
                      ' message title=null\n',
                      ' message title()="Work"@{}\n',
                      ' message title="Work"@{}\n message title="Other"@{}\n',
                      ' message title="Work"@{nl="Werk",NL="Ander"}\n',
                      ' message title="Work"@{nl=42}\n',
                      ' message title="Work"@{pt-BR="Tarefas"}\n',
                      ' message title="Work"@{nl="Werk"}@{de="Arbeit"}\n',
                      ' message title="Work"@ {nl="Werk"}\n',
                      ' message title="Work"@{}\n  message nested="Bad"@{}\n',
                      ' for Thing.title="Title"@{}\n'):
            with self.subTest(given=given):
                self.rejected(app(given))
        for value in ('"Hello {person}"@{}(actor)', '("Hello {person}"@{})(actor)', '"Hello"@{}()',
                      '"Hello"@{}(name=actor,name=actor)', '"Hello"@{}(name=actor,other)'):
            with self.subTest(value=value):
                self.rejected(app(then=' page / title='+value+'\n'))

    def test_translated_description_prose_escapes_and_locations(self):
        tree = self.accepted('# First line.\n# Literal \\@{marker} and path \\x. @{nl="Volledige tekst."}\n'
                             'app Test source="en"\nGiven\n Thing {\n'
                             '  # Field. @{"pt-BR"="Campo."}\n  value:int\n }\nWhen\nThen\n')
        owner = tree.data['declarations'][0]
        description = owner.data['description']
        self.assertEqual(description.kind, 'message_value')
        self.assertEqual(description.data['source'].data['value'], 'First line.\nLiteral @{marker} and path \\x.')
        variant = description.data['variants'][0]
        self.assertEqual((variant.token.line, variant.token.column), (2, 37))
        field = owner.data['sections'][0].data['declarations'][0].data['fields'][0]
        self.assertEqual(field.data['description'].data['variants'][0].token.line, 6)
        raw = self.accepted(app(' # Raw \\@{marker} and \\x.\n Thing {value:int}\n'))
        self.assertEqual(raw.data['declarations'][0].data['sections'][0].data['declarations'][0].data['description'], 'Raw @{marker} and \\x.')
        preserved = self.accepted('# Prose.  @{nl="Tekst."}\napp Test\nGiven\nWhen\nThen\n')
        self.assertEqual(preserved.data['declarations'][0].data['description'].data['source'].data['value'], 'Prose. ')
        for description in ('# First. @{nl="Eerste."}\n# Second.',
                            '# First. @{nl="Een."} trailing',
                            '# First. @{nl="Een."}@{de="Eins."}',
                            '# First. @{nl=42}', '# First. @{nl="Een.",NL="Twee."}'):
            with self.subTest(description=description):
                self.rejected(description+'\napp Test\nGiven\nWhen\nThen\n')
        error = self.rejected('# First. @{nl=42}\napp Test\nGiven\nWhen\nThen\n')
        self.assertEqual((error.line, error.column), (1, 15))

    def test_source_language_header_and_composed_metadata(self):
        tree = self.accepted('# Samen. @{en="Together."}\napp Together uses=[First] source="nl"\n'
                             'context\n locale default="en"\n'
                             'package words source="pt-BR" label="Words"@{}\n Given\n'
                             '  message heading="Tarefas"@{en="Tasks"}\n When\n Then\n')
        self.assertEqual(tree.data['declarations'][0].data['attributes']['source'].data['value'], 'nl')
        self.assertEqual(tree.data['declarations'][1].data['attributes']['source'].data['value'], 'pt-BR')
        for header in ('app Test source=nl', 'app Test source="en" source="nl"', 'app Test locales="nl"'):
            with self.subTest(header=header):
                self.rejected(header+'\nGiven\nWhen\nThen\n')
        self.rejected('package words source=nl\n Given\n When\n Then\n')

    def test_static_message_description_references(self):
        tree = self.accepted('#= app_description\napp Test\nGiven\n'
                      ' message app_description="Work"@{}\n'
                      ' #= model_description\n Thing {\n'
                      '  #= field_description\n  value:int\n }\nWhen\n'
                      ' #= operation_description\n scenario change(\n'
                      '  #= parameter_description\n  thing:Thing\n ) by=members\n'
                      '  do set thing {value=1}\nThen\n'
                      ' #= page_description\n page / title=heading\n')
        description = tree.data["declarations"][0].data["description_ref"]
        self.assertEqual(description.kind, "description_ref")
        self.assertEqual(description.data["path"].data["parts"], ["app_description"])
        self.accepted(app(' # = ordinary description prose\n Thing {value:int}\n'))
        for description in ('#= heading()', '#= heading+other', '#= heading\n# Prose',
                            '# Prose\n#= heading', '#= first\n#= second'):
            with self.subTest(description=description):
                self.rejected(description + '\napp Test\nGiven\nWhen\nThen\n')

    def test_localized_text_slots_and_locale_context(self):
        self.accepted('# Test application.\napp Test\ncontext\n locale default="nl"\n'
                      ' files types="application/pdf"\nGiven\n Thing {value:int}\nWhen\n'
                      ' # Change work.\n scenario change(thing:Thing) by=members\n'
                      '  require thing.value>0 message=positive_value\n'
                      '  do set thing {value=1}\nThen\n'
                      ' page / title=heading(user=actor)\n'
                      '  form change submit=submit_label\n'
                      '  list Thing empty=empty_label(count=0)\n')
        for context in (' locale\n', ' locale default=nl\n',
                        ' locale default="en" fallback="nl"\n'):
            with self.subTest(context=context):
                self.rejected('# App.\napp Test\ncontext\n' + context + 'Given\nWhen\nThen\n')

    def test_composed_app_imports_preserve_source_boundaries(self):
        self.accepted('# Together.\napp Together uses=[First,Second]\ncontext\n'
                      ' locale default="en"\n# Shared words.\n'
                      'use words {heading}; use other {description as intro}\n'
                      '# First.\napp First\nGiven\nWhen\nThen\n'
                      'package words\n Given\n  message heading="Work"@{}\n When\n Then\n')
        self.rejected('# Together.\napp Together uses=[First]\n'
                      'use words {heading}\nGiven\nWhen\nThen\n')

    def test_corpus_syntax_parses(self):
        sources = sorted([*ROOT.glob("examples/*.can"), *ROOT.glob("draft/*.can"),
                          *ROOT.glob("draft/shared/*.can")])
        self.assertEqual(len(sources), 44)
        for path in sources:
            with self.subTest(path=str(path.relative_to(ROOT))):
                parse(path.read_text(encoding="utf-8"), path=str(path))


if __name__ == "__main__":
    unittest.main()
