from pathlib import Path
import re,json,hashlib,os
os.environ.setdefault('TIKTOKEN_CACHE_DIR','/tmp/canlang-eval-tokenizer-20261004/cache')
import tiktoken
BASE=Path('design/evaluation/baseline-20261004T041647Z/snapshot/examples/TeamTasks.can')
OUT=Path('design/evaluation/evidence/interfaces')
s=BASE.read_text()
# Evidence-only, handcrafted translations; no compiler/translation-quality claim.
translations={
'Beheer teamtaken, wijs actieve teamleden toe en volg de voortgang.':'Verwalte Teamaufgaben, weise aktive Teammitglieder zu und verfolge den Fortschritt.',
'Taakweergave':'Aufgabenansicht','Alle taken':'Alle Aufgaben','Open taken':'Offene Aufgaben','Afgeronde taken':'Erledigte Aufgaben','Open':'Offen','Toegewezen aan':'Zugewiesen an','Taak':'Aufgabe','Toevoegen':'Hinzufügen','Titel':'Titel','Klaar':'Erledigt',
'{n, plural, one {# taak} other {# taken}}':'{n, plural, one {# Aufgabe} other {# Aufgaben}}',
'Voeg werk toe, wijs teamleden toe en volg wat klaar is.':'Füge Arbeit hinzu, weise Teammitglieder zu und verfolge die erledigten Aufgaben.',
'Teamtaken':'Teamaufgaben','Teamwerk toevoegen':'Teamaufgabe hinzufügen','Taken en voortgang':'Aufgaben und Fortschritt','Nog geen taken. Voeg je eerste taak toe.':'Noch keine Aufgaben. Füge deine erste Aufgabe hinzu.',
'Bewaar gedeelde teamnotities.':'Bewahre gemeinsame Teamnotizen auf.','Notitie-inhoud uitklappen':'Notizinhalt ausklappen','Inhoud':'Inhalt','Notitie':'Notiz','Schrijf en bekijk de notities van het team.':'Schreibe und lies die Notizen des Teams.','Teamnotities':'Teamnotizen','Een notitie schrijven':'Notiz schreiben','Gedeelde notities':'Gemeinsame Notizen','Notitie-inhoud':'Notizinhalt','Beheer taken en notities samen.':'Verwalte Aufgaben und Notizen gemeinsam.'}
seen=[]
def add(m):
 nl=json.loads('"'+m[1]+'"'); seen.append(nl)
 if nl not in translations: raise ValueError(nl)
 return 'nl='+json.dumps(nl,ensure_ascii=False)+',de='+json.dumps(translations[nl],ensure_ascii=False)
added=re.sub(r'nl="((?:[^"\\]|\\.)*)"',add,s)
(OUT/'TeamTasks-de.can').write_text(added)
edited=added.replace('{n, plural, one {# task} other {# tasks}}','{n, plural, one {# active task} other {# active tasks}}').replace('{n, plural, one {# taak} other {# taken}}','{n, plural, one {# actieve taak} other {# actieve taken}}').replace('{n, plural, one {# Aufgabe} other {# Aufgaben}}','{n, plural, one {# aktive Aufgabe} other {# aktive Aufgaben}}').replace('"1 taak"','"1 actieve taak"')
(OUT/'TeamTasks-de-message-edit.can').write_text(edited)
enc={n:tiktoken.get_encoding(n) for n in ('o200k_base','cl100k_base')}
def measure(text): return {'utf8_bytes':len(text.encode()),'lines':len(text.splitlines()),'tokens':{n:len(e.encode(text,disallowed_special=())) for n,e in enc.items()}}
result={'method':'Bounded handcrafted draft edit, tiktoken 0.12.0 two reference encodings; not actual GPT-6 usage. No compiler or runtime executed. Shared DE catalog/coverage is a platform obligation, not asserted translated here.','baseline':str(BASE),'baseline_sha256':hashlib.sha256(s.encode()).hexdigest(),'asset_sites_added':len(seen),'unique_complete_translations':len(set(seen)),'baseline_measure':measure(s),'added_locale_measure':measure(added),'edited_message_measure':measure(edited),'locale_diff_added_lines':sum(a!=b for a,b in zip(s.splitlines(),added.splitlines())),'message_diff_changed_lines':sum(a!=b for a,b in zip(added.splitlines(),edited.splitlines())),'parameter_contract':'task_count(n:int), n bound explicitly; unchanged from baseline','no_new_locale_file_or_alignment_required':True}
(OUT/'locale-measurements.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result,indent=2))
