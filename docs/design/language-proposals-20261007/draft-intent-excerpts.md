# Source excerpts

Verbatim source data. Resolve source-local links from the original owning file named in each excerpt.

````text
## draft/CanRent.can local ignored draft intent lines 1580 through 1610
1580:      collapse policy_title
1581:       text row.timezone,row.currency,row.increment,row.minimum,row.terms,row.refund_notice
1582:      card "Check an hourly interval"@{nl="Een tijdvak per uur controleren"}
1583:       require row.price_unit==hour
1584:       form available
1585:        text result.available
1586:        ## total:money caption from DS-9.1 shared vocabulary.
1587:        stat result.total
1588:        content result.terms
1589:        text result.refund_before
1590:        card "Hold this interval"@{nl="Dit tijdvak tijdelijk reserveren"}
1591:         require result.available
1592:         form hold arguments={resource=result.resource,from=result.from,until=result.until,quantity=result.quantity,attendees=result.attendees}
1593:          fieldset
1594:           select customer
1595:           ## proposed: email as input's "appropriate scalar"; checker confirms.
1596:           input email
1597:           checkbox use_allowance
1598:           validator email
1599:      card "Check local workspace days"@{nl="Lokale werkplekdagen controleren"}
1600:       require row.price_unit==day
1601:       form available_days
1602:        text result.available
1603:        stat result.total
1604:        content result.terms
1605:        card "Hold these days"@{nl="Deze dagen tijdelijk reserveren"}
1606:         require result.available
1607:         form hold_days arguments={resource=result.resource,start=result.start,end=result.end,quantity=result.quantity,attendees=result.attendees}
1608:          fieldset
1609:           select customer
1610:           input email

## draft/CanLeave.can local ignored draft intent lines 250 through 266
250:    card "Leave dates and allowance"@{nl="Verlofdatums en tegoed"} layout=columns
251:     card "Working calendar and request intake"@{nl="Werkkalender en verlofaanvraag"}
252:      list Calendar as calendar where calendar.parent.user==actor display=split empty="No working calendar."@{nl="Geen werkkalender."}
253:       pagination
254:       form preview
255:        stat result.days
256:        list result.portions empty="No counted days."@{nl="Geen getelde dagen."}
257:         pagination
258:         text row.year,row.days,row.allowance?.remaining
259:       form request display=inline
260:        fieldset "Request leave"@{nl="Verlof aanvragen"}
261:         calendar from
262:         calendar until
263:         input bucket
264:         textarea reason
265:       table row.Day columns=date,working empty="No calendar days configured."@{nl="Geen kalenderdagen ingesteld."}
266:        pagination

## draft/CanLoyalty.can local ignored draft intent lines 26 through 34
26:   SourceEvidence in Account { source:text unique, value:Qualification, reversed:bool=false, decided:bool=false }
27:   Earning in Account { tier:bool=false label="Counts toward tier"@{nl="Telt mee voor niveau"}, author:user?, qualification:SourceEvidence?, source:text unique label=label_Earning_source, points:int label="Points"@{nl="Punten"}, reason:text, reversal:Earning? label="Reversed entry"@{nl="Tegenboeking"} } label="Points entry"@{nl="Puntenboeking"}
28:   Redemption in Account { reward:Reward, name:text, instructions:text, locations:Location[]!, location:Location, fulfilled_by:user?, cancelled_by:user?, notification_delivery:delivery(Mail.send)?, cost:int label=label_Reward_cost, state:enum(reserved,fulfilled,cancelled)=reserved label={text="State"@{nl="Status"},values={reserved="Reserved"@{nl="Gereserveerd"},fulfilled="Fulfilled"@{nl="Uitgevoerd"},cancelled="Cancelled"@{nl="Geannuleerd"}}}, evidence:text?, source:text unique label=label_Earning_source } label="Reward reservation"@{nl="Beloningsreservering"}
29:   ## Notification outcome observes the Mail receipt; null means no notice was requested.
30:   derive Redemption.notification:DeliveryResult.status? = row.notification_delivery?.status label="Notification outcome"@{nl="Meldingsresultaat"}
31:   derive Account.earned:int = sum(row.Earning as earning where earning.tier select earning.points) label="Earned points"@{nl="Verdiende punten"}
32:   derive Account.available:int = sum(row.Earning as earning select earning.points)-sum(row.Redemption as redemption where redemption.state in [reserved,fulfilled] select redemption.cost) label="Available points"@{nl="Beschikbare punten"}
33:   derive Account.tier:Tier? = first(row.parent.Tier as tier where tier.threshold<=row.earned order=-tier.threshold) label="Current tier"@{nl="Huidig niveau"}
34:   derive Account.next_tier:Tier? = first(row.parent.Tier as tier where tier.threshold>row.earned order=tier.threshold) label="Next tier"@{nl="Volgend niveau"}

## draft/CanLoyalty.can local ignored draft intent lines 148 through 156
148:   scenario reverse(entry:Earning,reason:text) by=reward_staff
149:    require entry.reversal==null and trim(reason)!="" and all(entry.parent.parent.locations as location,can_work(actor,location)) and not any(entry.parent.Earning as item,item.reversal==entry)
150:    do create Earning {parent=entry.parent,source=format("reversal:{id}",{id=entry.id}),points=-entry.points,reason,tier=entry.tier,author=actor,qualification=entry.qualification,reversal=entry} as reversal
151:    examples seed=[test_worker] entry=credited reason="Credit entered in error"
152:     as -> wallet.available,wallet.earned,count(wallet.Earning)
153:     reward_staff -> 0,0,2
154:     members -> error(forbidden)
155:    examples seed=[test_worker,reversed] entry=credited reason="Duplicate correction"
156:     as -> wallet.available

## draft/CanLoyalty.can local ignored draft intent lines 197 through 212
197:     observed.value.revision,event.value.revision,observed.reversed,event.value.milestone -> wallet.available,count(wallet.Earning),observed.value.revision
198:     2,1,false,completed -> 0,0,2
199:     1,2,true,completed -> 0,0,2
200:     1,1,false,completed -> 0,0,1
201:    examples event={value={source="sale",revision=1,customer=test_company.id,account=self,location=test_site.id,product="meeting",amount=money(100,"EUR"),purchased_at=datetime("2026-10-01T00:00:00Z"),occurred=datetime("2026-10-02T00:00:00Z"),milestone=completed,first_customer=false,history_known=false}}
202:     event.value.milestone -> count(Account),count(Earning)
203:     completed -> 0,0
204:    examples seed=[credited,reservation] event={value=observed.value}
205:     event.value.revision,event.value.milestone,perks.active -> wallet.available,wallet.earned,count(wallet.Earning)
206:     1,completed,true -> -50,10,1
207:     2,reversed,false -> -60,0,2
208:     1,reversed,true -> error(rule_failed)
209:     0,completed,true -> error(validation)
210:    examples seed=[reversed] event={value=observed.value}
211:     observed.reversed,event.value.revision,event.value.milestone -> wallet.available,wallet.earned,count(wallet.Earning)
212:     true,2,reversed -> 0,0,2

## draft/CanApprove.can local ignored draft intent lines 56 through 73
56:   scenario reviewer_choices(document:Document) read=true -> Employee[] by=members label="Choose reviewer"@{nl="Beoordelaar kiezen"}
57:    require (document.submitter==actor or coordinator) and (document.location==null or can_work(actor,document.location))
58:    do return Employee as candidate where candidate.active and candidate.user!=actor and candidate.user!=document.submitter and reviewer(candidate.user) and (document.location==null or can_work(candidate.user,document.location))
59:    examples seed=[test_worker,reviewer_worker,replacement_worker,ordinary_worker,coordinator_worker] document=document
60:     as,document.submitter,document.location,reviewer_worker.active,reviewer_worker.name,test_worker.active -> count(result),count(result as candidate where candidate.name=="Alex"),any(result as candidate,candidate.user==ordinary_user)
61:     self,self,test_site,true,"Alex",true -> 2,2,false
62:     self,self,test_site,false,"Alex",true -> 1,1,false
63:     self,self,null,false,"Alex",true -> 1,1,false
64:     self,self,test_site,true,null,true -> 2,1,false
65:     coordinator_user,self,test_site,true,"Alex",true -> 2,2,false
66:     reviewer_user,reviewer_user,test_site,true,"Alex",true -> 1,1,false
67:     reviewer_user,self,test_site,true,"Alex",true -> error(rule_failed)
68:     self,self,test_site,true,"Alex",false -> error(rule_failed)
69:     self,self,null,true,"Alex",false -> 0,0,false
70:     outsider,self,test_site,true,"Alex",true -> error(forbidden)
71:     public,self,test_site,true,"Alex",true -> error(forbidden)
72:    ## Receipt snapshots are canonical bound recipes. An unrelated failed receipt cannot alter this Notice's selected pending receipt.
73:    examples seed=[pending_notice,test_worker,detached_delivery] document=document

## draft/CanApprove.can local ignored draft intent lines 293 through 320
293:      form reviewer_choices arguments={document}
294:       list result as candidate columns=name,user,role,home
295:        pagination
296:        form submit arguments={document,assignee=candidate.user}
297:     ## Collapse shares the details disclosure contract; open= applies only to Collapse.
298:     collapse "Submitted version history"@{nl="Ingediende versiehistorie"} open=preferences.versions_open
299:      table row.Submission columns=revision,file,note,reviewer,due,overdue,state,reason order=-revision filter=state,reviewer,overdue
300:       pagination
301:       badge row.state
302:       status row.overdue
303:       button action=withdraw arguments={submission=row}
304:       collapse "Version decision history"@{nl="Besluithistorie versies"}
305:        text row.decided_by,row.decided_at
306:        history
307:       table row.Notice columns=assignment,kind,recipient,state,created_by,created order=created
308:        pagination
309:   # Review assigned submissions or coordinate permitted assignments. @{nl="Beoordeel toegewezen inzendingen of coördineer toegestane toewijzingen."}
310:   page /documents/review title="Review queue"@{nl="Beoordelingswachtrij"}
311:    require reviewer or coordinator
312:    breadcrumbs
313:    table Submission as submission columns=parent,revision,file,note,reviewer,due,overdue,state order=due filter=state,reviewer,parent.location,parent.category,overdue defaults={state=preferences.review_state} display=split
314:     pagination
315:     card "Exact submitted version"@{nl="Exact ingediende versie"}
316:      badge row.state
317:      status row.overdue
318:      text row.revision,row.file,row.note,row.due,row.reason
319:      ## One binding per button; each modal id is unique in this page scope; the external opener suppresses the implicit opener.
320:      join

## draft/CanApprove.can local ignored draft intent lines 332 through 355
332:      form reviewer_choices arguments={document=submission.parent}
333:       list result as candidate columns=name,user,role,home
334:        pagination
335:        form assign arguments={submission,assignee=candidate.user}
336:     collapse "Review history"@{nl="Beoordelingshistorie"}
337:      text row.decided_by,row.decided_at
338:      history
339:     table row.Notice columns=assignment,kind,recipient,state,created_by,created order=created
340:      pagination

## draft/CanBook.can local ignored draft intent lines 64 through 106
64:   crud ClosedDay by=host_manager fields=day,reason when=can_work(actor,row.parent.location) delete=remove
65:   crud Type by=host_manager fields=name,duration,room when=can_work(actor,row.parent.location) delete=none
66:   # Freeze duration and venue, then acquire both resources before confirmation. @{nl="Leg duur en ruimte vast en verkrijg beide voorzieningen vóór bevestiging."}
67:   export scenario book(type:Type,customer:Customer,contact:Contact,from:datetime label=label_Window_from) by=authenticated label="Book appointment"@{nl="Afspraak boeken"}
68:    require type.parent.active and type.parent.host.active and from>=now and contact.parent==customer
69:    require (contact.account==actor and contact.verified) or (host_manager and can_work(actor,type.parent.location))
70:    require any(type.parent.Window as window,window.available and window.from<=from and from+type.duration<=window.until)
71:    require available(type.parent,from,from+type.duration)
72:    do
73:     create Appointment {parent=type,customer,contact,from,until=from+type.duration,duration=type.duration,source=operation.id,active_source=operation.id,host=type.parent.host.user,room_snapshot=type.room} as visit
74:     create Attempt {parent=visit,source=operation.id,kind=initial,from,until=visit.until,room_ok=type.room==null,room_released=type.room==null} as attempt
75:     send StaffSchedule.reserve {value={source=attempt.source,employee=visit.host,location=type.parent.location.id,from,until=attempt.until,skill="host",kind=appointment,revision=1}} as host_hold
76:     set attempt {host_delivery=host_hold.id}
77:     set visit {host_delivery=host_hold.id}
78:     if visit.room_snapshot!=null
79:      send Rooms.hold {value={source=attempt.source,resource=visit.room_snapshot,customer=customer.id,account=visit.reservation_account,from,until=attempt.until,quantity=1,revision=1}} as room_hold
80:      set attempt {room_delivery=room_hold.id}
81:      set visit {room_delivery=room_hold.id}
82:     else
83:      set visit {room_ok=true}
84:    examples seed=[test_worker,open_site,opening,published,closure] type=tour customer=test_company contact=test_contact from=datetime("2099-01-01T09:00:00Z")
85:     as,closure.day -> count(Appointment as visit where visit.source==operation.id)
86:     members,date("2099-01-02") -> 1
87:     members,date("2099-01-01") -> error(rule_failed)
88:     public,date("2099-01-02") -> error(forbidden)
89:   # Stage a replacement while the original host and venue remain allocated. @{nl="Bereid vervanging voor terwijl de oorspronkelijke gastheer en ruimte gereserveerd blijven."}
90:   export scenario reschedule(visit:Appointment,from:datetime label=label_Window_from) by=authenticated or host_manager label="Reschedule appointment"@{nl="Afspraak verplaatsen"}
91:    require visit.state in [confirmed,unavailable] and from>=now and from!=visit.from
92:    require (visit.contact.account==actor and visit.contact.verified and (visit.state==unavailable or now<visit.from-visit.parent.parent.cutoff)) or (host_manager and can_work(actor,visit.parent.parent.location))
93:    require visit.parent.parent.active and available(visit.parent.parent,from,from+visit.duration)
94:    require not any(visit.Attempt as attempt,attempt.state in [pending,failed,cancelled,retired])
95:    do
96:     let previous=first(visit.Attempt as attempt where attempt.source==visit.active_source and attempt.state==active order=attempt.id)
97:     require previous!=null
98:     create Attempt {parent=visit,source=operation.id,kind=movement,from,until=from+visit.duration,previous_source=previous.source,previous_host_revision=previous.host_revision,previous_room_revision=previous.room_revision,room_ok=visit.room_snapshot==null,room_released=visit.room_snapshot==null} as attempt
99:     send StaffSchedule.stage {value={source=attempt.source,employee=visit.host,location=visit.parent.parent.location.id,from,until=attempt.until,skill="host",kind=appointment,revision=1},previous_source=previous.source,previous_revision=previous.host_revision} as host_hold
100:     set attempt {host_delivery=host_hold.id}
101:     if visit.room_snapshot!=null
102:      send Rooms.stage {value={source=attempt.source,resource=visit.room_snapshot,customer=visit.customer.id,account=visit.reservation_account,from,until=attempt.until,quantity=1,revision=1},previous_source=previous.source,previous_revision=previous.room_revision} as room_hold
103:      set attempt {room_delivery=room_hold.id}
104:    examples seed=[test_worker,open_site,opening,published,original] visit=booked
105:     as,from -> visit.from,count(visit.Attempt)
106:     members,datetime("2099-01-01T10:00:00Z") -> datetime("2099-01-01T09:00:00Z"),2

## draft/CanCreative.can local ignored draft intent lines 187 through 211
187:   page /creative title="Image studio"@{nl="Beeldstudio"} poll=1s
188:    require members
189:    breadcrumbs
190:    form generate display=inline
191:     fieldset "Image prompt"@{nl="Beeldprompt"}
192:      select template
193:      textarea prompt
194:      textarea negative
195:     fieldset "Size and context"@{nl="Formaat en context"}
196:      input width
197:      input height
198:      select conversation
199:    list Run as run where can_view(actor,run) order=-created empty="No image jobs yet"@{nl="Nog geen beeldtaken"}
200:     pagination
201:     title row.prompt
202:     status row.delivery_state
203:     status row.stop_delivery
204:     status row.reconcile_delivery
205:     badge row.state
206:     text row.stop_requested,row.used,row.detail
207:     loading row.unfinished
208:     gallery row.Output image=image order=position empty="No images yet"@{nl="Nog geen beelden"}
209:      pagination
210:     actions stop,reconcile,release_skipped
211:    table Budget columns=cap,spent,held,running,active empty="No image-job allowances"@{nl="Geen budgetten voor beeldtaken"}
````
