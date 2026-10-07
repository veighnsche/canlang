# Source excerpts

Verbatim source data. Resolve source-local links from the original owning file named in each excerpt.

````text
## design/evaluation/baseline-20261004T041647Z/snapshot/draft/CanRent.can at 4e89b117d3f66caa79a8df8ed875d55f9e40b948 historical October 4 intent lines 1233 through 1249
1233:      details policy_title
1234:       text row.timezone,row.currency,row.increment,row.minimum,row.terms,row.refund_notice
1235:      card "Check an hourly interval"@{nl="Een tijdvak per uur controleren"}
1236:       require row.price_unit==hour
1237:       form available
1238:        text result.available,result.total,result.terms,result.refund_before
1239:        card "Hold this interval"@{nl="Dit tijdvak tijdelijk reserveren"}
1240:         require result.available
1241:         form hold arguments={resource=result.resource,from=result.from,until=result.until,quantity=result.quantity,attendees=result.attendees}
1242:      card "Check local workspace days"@{nl="Lokale werkplekdagen controleren"}
1243:       require row.price_unit==day
1244:       form available_days
1245:        text result.available,result.total,result.terms
1246:        card "Hold these days"@{nl="Deze dagen tijdelijk reserveren"}
1247:         require result.available
1248:         form hold_days arguments={resource=result.resource,start=result.start,end=result.end,quantity=result.quantity,attendees=result.attendees}
1249:   # Manage availability, current holds and affected downtime. @{nl="Beheer beschikbaarheid, huidige tijdelijke reserveringen en getroffen uitval."}

## design/evaluation/baseline-20261004T041647Z/snapshot/draft/CanLeave.can at 4e89b117d3f66caa79a8df8ed875d55f9e40b948 historical October 4 intent lines 213 through 219
213:       form preview
214:        text result.days
215:        list result.portions
216:         text row.year,row.days,row.allowance?.remaining
217:       form request
218:       table row.Day columns=date,working
219:       table row.Request columns=from,until,bucket,state,decision,sync order=-from filter=bucket,state defaults={bucket=preferences.bucket}

## design/evaluation/baseline-20261004T041647Z/snapshot/draft/CanLoyalty.can at 4e89b117d3f66caa79a8df8ed875d55f9e40b948 historical October 4 intent lines 26 through 30
26:   Earning in Account { tier:bool=false label="Counts toward tier"@{nl="Telt mee voor niveau"}, author:user?, qualification:SourceEvidence?, source:text unique label=label_Earning_source, points:int label="Points"@{nl="Punten"}, reason:text, reversal:Earning? label="Reversed entry"@{nl="Tegenboeking"} } label="Points entry"@{nl="Puntenboeking"}
27:   Redemption in Account { reward:Reward, name:text, instructions:text, locations:Location[]!, location:Location, fulfilled_by:user?, cancelled_by:user?, notification:DeliveryResult.status=pending label="Notification outcome"@{nl="Meldingsresultaat"}, notification_delivery:text?, cost:int label=label_Reward_cost, state:enum(reserved,fulfilled,cancelled)=reserved label={text="State"@{nl="Status"},values={reserved="Reserved"@{nl="Gereserveerd"},fulfilled="Fulfilled"@{nl="Uitgevoerd"},cancelled="Cancelled"@{nl="Geannuleerd"}}}, evidence:text?, source:text unique label=label_Earning_source } label="Reward reservation"@{nl="Beloningsreservering"}
28:   derive Account.earned:int = sum(row.Earning as earning where earning.tier select earning.points) label="Earned points"@{nl="Verdiende punten"}
29:   derive Account.available:int = sum(row.Earning as earning select earning.points)-sum(row.Redemption as redemption where redemption.state in [reserved,fulfilled] select redemption.cost) label="Available points"@{nl="Beschikbare punten"}
30:   derive Account.tier:Tier? = first(row.parent.Tier as tier where tier.threshold<=row.earned order=-tier.threshold) label="Current tier"@{nl="Huidig niveau"}

## design/evaluation/baseline-20261004T041647Z/snapshot/draft/CanApprove.can at 4e89b117d3f66caa79a8df8ed875d55f9e40b948 historical October 4 intent lines 293 through 320


## design/evaluation/baseline-20261004T041647Z/snapshot/draft/CanApprove.can at 4e89b117d3f66caa79a8df8ed875d55f9e40b948 historical October 4 intent lines 332 through 355


## design/evaluation/baseline-20261004T041647Z/snapshot/draft/CanBook.can at 4e89b117d3f66caa79a8df8ed875d55f9e40b948 historical October 4 intent lines 64 through 106
64:    require type.parent.active and type.parent.host.active and from>=now and contact.parent==customer
65:    require (contact.account==actor and contact.verified) or (host_manager and can_work(actor,type.parent.location))
66:    require any(type.parent.Window as window,window.available and window.from<=from and from+type.duration<=window.until)
67:    require available(type.parent,from,from+type.duration)
68:    do
69:     create Appointment {parent=type,customer,contact,from,until=from+type.duration,duration=type.duration,source=operation.id,active_source=operation.id,host=type.parent.host.user,room_snapshot=type.room} as visit
70:     create Attempt {parent=visit,source=operation.id,kind=initial,from,until=visit.until,room_ok=type.room==null,room_released=type.room==null} as attempt
71:     send StaffSchedule.reserve {value={source=attempt.source,employee=visit.host,location=type.parent.location.id,from,until=attempt.until,skill="host",kind=appointment,revision=1}} as host_hold
72:     set attempt {host_delivery=host_hold.id}
73:     set visit {host_delivery=host_hold.id}
74:     if visit.room_snapshot!=null
75:      send Rooms.hold {value={source=attempt.source,resource=visit.room_snapshot,customer=customer.id,account=visit.reservation_account,from,until=attempt.until,quantity=1,revision=1}} as room_hold
76:      set attempt {room_delivery=room_hold.id}
77:      set visit {room_delivery=room_hold.id}
78:     else
79:      set visit {room_ok=true}
80:    examples seed=[test_worker,open_site,opening,published,closure] type=tour customer=test_company contact=test_contact from=datetime("2099-01-01T09:00:00Z")
81:     as,closure.day -> count(Appointment as visit where visit.source==operation.id)
82:     members,date("2099-01-02") -> 1
83:     members,date("2099-01-01") -> error(rule_failed)
84:     public,date("2099-01-02") -> error(forbidden)
85:   # Stage a replacement while the original host and venue remain allocated. @{nl="Bereid vervanging voor terwijl de oorspronkelijke gastheer en ruimte gereserveerd blijven."}
86:   export scenario reschedule(visit:Appointment,from:datetime label=label_Window_from) by=authenticated or host_manager label="Reschedule appointment"@{nl="Afspraak verplaatsen"}
87:    require visit.state==confirmed and from>=now and from!=visit.from
88:    require (visit.contact.account==actor and visit.contact.verified and now<visit.from-visit.parent.parent.cutoff) or (host_manager and can_work(actor,visit.parent.parent.location))
89:    require visit.parent.parent.active and available(visit.parent.parent,from,from+visit.duration)
90:    require not any(visit.Attempt as attempt,attempt.state in [pending,failed,cancelled,retired])
91:    do
92:     let previous=first(visit.Attempt as attempt where attempt.source==visit.active_source and attempt.state==active order=attempt.id)
93:     require previous!=null
94:     create Attempt {parent=visit,source=operation.id,kind=movement,from,until=from+visit.duration,previous_source=previous.source,previous_host_revision=previous.host_revision,previous_room_revision=previous.room_revision,room_ok=visit.room_snapshot==null,room_released=visit.room_snapshot==null} as attempt
95:     send StaffSchedule.stage {value={source=attempt.source,employee=visit.host,location=visit.parent.parent.location.id,from,until=attempt.until,skill="host",kind=appointment,revision=1},previous_source=previous.source,previous_revision=previous.host_revision} as host_hold
96:     set attempt {host_delivery=host_hold.id}
97:     if visit.room_snapshot!=null
98:      send Rooms.stage {value={source=attempt.source,resource=visit.room_snapshot,customer=visit.customer.id,account=visit.reservation_account,from,until=attempt.until,quantity=1,revision=1},previous_source=previous.source,previous_revision=previous.room_revision} as room_hold
99:      set attempt {room_delivery=room_hold.id}
100:    examples seed=[test_worker,open_site,opening,published,original] visit=booked
101:     as,from -> visit.from,count(visit.Attempt)
102:     members,datetime("2099-01-01T10:00:00Z") -> datetime("2099-01-01T09:00:00Z"),2
103:     members,datetime("2099-01-01T09:00:00Z") -> error(rule_failed)
104:     public,datetime("2099-01-01T10:00:00Z") -> error(forbidden)
105:   # Cancel the active reservation and all pending candidates with recoverable releases. @{nl="Annuleer de actieve reservering en alle wachtende kandidaten met herstelbare vrijgave."}
106:   export scenario cancel(appointment:Appointment,reason:text) by=authenticated or host_manager
````
