import * as express from "express";
import * as samlp from "samlp";
import { Config } from "./Config";
import { Audit } from "./Audit";
import { LoginProvider } from "./LoginProvider";
import { NoderedUtil, TokenUser } from "@openiap/openflow-api";
import { Span } from "@opentelemetry/api";
import { Logger } from "./Logger";

export class SamlProvider {
    public static profileMapper(pu: any): any {
        return {
            pu: pu,
            getClaims: function (): any {
                const claims: any = {};
                const k: string[] = Object.keys(this.pu);
                k.forEach(key => {
                    if (key.indexOf("http://") === 0) {
                        claims[key] = this.pu[key];
                    } else {
                        switch (key) {
                            case "id":
                                claims["http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier"] = this.pu[key]; break;
                            case "displayName":
                                claims["http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name"] = this.pu[key]; break;
                            case "name":
                                claims["http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name"] = this.pu[key]; break;
                            case "mobile":
                                claims["http://schemas.xmlsoap.org/ws/2005/05/identity/claims/mobile"] = this.pu[key]; break;
                            case "username":
                                claims["http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier"] = this.pu[key]; break;
                            case "emails":
                                claims["http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress"] = this.pu[key][0];
                                claims["http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier"] = this.pu[key][0]; break;
                            case "roles":
                                const roles: string[] = [];
                                this.pu[key].forEach(role => {
                                    roles.push(role.name);
                                });
                                claims["http://schemas.xmlsoap.org/claims/Group"] = roles;
                        }
                    }
                });
                return claims;
            },
            getNameIdentifier: function (): any {
                const claims: any = this.getClaims();
                return {
                    nameIdentifier: claims["http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier"] ||
                        claims["http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name"] ||
                        claims["http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress"]
                };
            }
        };
    }

    static configure(app: express.Express, baseurl: string): void {
        const cert: string = Buffer.from(Config.signing_crt, "base64").toString("ascii");
        const key: string = Buffer.from(Config.singing_key, "base64").toString("ascii");

        const samlpoptions: any = {
            issuer: Config.saml_issuer,
            cert: cert,
            key: key,
            getPostURL: (wtrealm: any, wreply: any, req: any, callback: any) => {
                (async () => {
                    if (typeof wreply === "object") {
                        wreply = wreply.documentElement.getAttribute("AssertionConsumerServiceURL");
                    }
                    return callback(null, wreply);
                })();

            },
            getUserFromRequest: (req: any) => {
                const span: Span = Logger.otel.startSpan("SAML.getUserFromRequest");
                try {
                    const tuser: TokenUser = TokenUser.From(req.user);
                    let remoteip = "";
                    if (!NoderedUtil.IsNullUndefinded(req)) {
                        if (!NoderedUtil.IsNullUndefinded(req.connection) && !NoderedUtil.IsNullEmpty(req.connection.remoteAddress)) remoteip = req.connection.remoteAddress;
                        if (!NoderedUtil.IsNullUndefinded(req.headers)) {
                            if (req.headers["X-Forwarded-For"] != null) remoteip = req.headers["X-Forwarded-For"];
                            if (req.headers["X-real-IP"] != null) remoteip = req.headers["X-real-IP"];
                            if (req.headers["x-forwarded-for"] != null) remoteip = req.headers["x-forwarded-for"];
                            if (req.headers["x-real-ip"] != null) remoteip = req.headers["x-real-ip"];
                        }
                    }
                    // if (req.connection) { remoteip = req.connection.remoteAddress; }
                    Audit.LoginSuccess(tuser, "tokenissued", "saml", remoteip, "getUserFromRequest", "unknown", span);
                } catch (error) {
                    span.recordException(error);
                }
                Logger.otel.endSpan(span);
                return req.user;
            },
            profileMapper: SamlProvider.profileMapper,
            lifetimeInSeconds: (3600 * 24)
        };

        app.get("/issue/", (req: any, res: any, next: any): void => {
            if (req.query.SAMLRequest !== undefined && req.query.SAMLRequest !== null) {
                if ((req.user === undefined || req.user === null)) {
                    try {
                        // tslint:disable-next-line: max-line-length
                        samlp.parseRequest(req, samlpoptions, async (_err: any, samlRequestDom: any): Promise<void> => {
                            res.cookie("originalUrl", req.originalUrl, { maxAge: 900000, httpOnly: true });
                            res.redirect("/");
                        });
                    } catch (error) {
                        res.body(error.message ? error.message : error);
                        res.end();
                        console.error(error.message ? error.message : error);
                    }
                } else {
                    // continue with issuing token using samlp
                    next();
                }
            } else {
                res.send("Please login again");
                res.end();
            }
        });

        app.get("/issue/", samlp.auth(samlpoptions));
        app.get("/issue/FederationMetadata/2007-06/FederationMetadata.xml", samlp.metadata({
            issuer: Config.saml_issuer,
            cert: cert,
        }));
        // const SessionParticipants = require('samlp/lib/sessionParticipants');

        // https://github.com/mcguinness/saml-idp/blob/master/app.js
        // https://www.diycode.cc/projects/auth0/node-samlp
        // https://github.com/auth0/node-samlp/blob/master/lib/sessionParticipants/index.js
        // app.get('/logout', samlp.logout({
        //     deflate:            true,
        //     issuer:             'the-issuer',
        //     protocolBinding:    'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect',
        //     cert:               cert,
        //     key:                key
        // }));

        // TODO: FIX !!!!
        app.get('/wssignout', async (req: any, res: any, next: any) => {
            req.logout();
            let html = "<html><head></head><body>";
            html += "<h1>Du er nu logget ud</h1><br>";
            // html += "<br/><p><a href='/'>Til login</ifarame></p>";
            html += "</body></html>";
            res.send(html);
        });
        app.post('/wssignout', async (req: any, res: any, next: any) => {
            req.logout();
            let html = "<html><head></head><body>";
            html += "<h1>Du er nu logget ud</h1><br>";
            // html += "<br/><p><a href='/'>Til login</ifarame></p>";
            html += "</body></html>";
            res.send(html);
        });
        app.get('/logout', async (req: any, res: any, next: any) => {
            const referer: string = req.headers.referer;
            const providerid: any = req.cookies.provider;
            req.logout();

            if (!NoderedUtil.IsNullEmpty(providerid)) {
                const p = LoginProvider.login_providers.filter(x => x.id == providerid);
                if (p.length > 0) {
                    const provider = p[0];
                    if (!NoderedUtil.IsNullEmpty(provider.saml_signout_url)) {
                        let html = "<html><head></head><body>";
                        html += "<h1>Logud</h1><br>";
                        if (!NoderedUtil.IsNullEmpty(referer)) {
                            html += "<br/><p><a href='" + encodeURI(referer) + "'>Til login</a></p>";
                        } else {
                            html += "<br/><p><a href='/'>Til login</a></p>";
                        }
                        html += "<iframe src='" + encodeURI(provider.saml_signout_url) + "'></iframe>";
                        if (!NoderedUtil.IsNullEmpty(referer)) {
                            html += "<br/><p><a href='" + encodeURI(referer) + "'>Til login</a></p>";
                        } else {
                            html += "<br/><p><a href='/'>Til login</a></p>";
                        }
                        html += "</body></html>";
                        res.send(html);
                        return;
                    }
                }
            }
            if (!NoderedUtil.IsNullEmpty(referer)) {
                res.redirect(referer);
            } else {
                res.redirect("/");
            }
            // samlp.logout({
            //     issuer: Config.saml_issuer,
            //     protocolBinding: 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST',
            //     cert: cert,
            //     key: key
            // })(req, res, next);
        });

        app.post('/logout', (req: any, res: any, next: any): void => {

            samlp.logout({
                issuer: Config.saml_issuer,
                protocolBinding: 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST',
                cert: cert,
                key: key
            })(req, res, next);

        });

    }
}