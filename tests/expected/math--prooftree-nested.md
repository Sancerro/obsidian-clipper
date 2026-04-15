```json
{
  "title": "Prooftree with Nested Delimiters",
  "author": "",
  "site": "",
  "published": ""
}
```

## Natural Deduction Rules

Inline prooftree with nested delimiters:

*modus ponens*: 
$$
\begin{prooftree}
\AxiomC{\rA\supset\rB}\AxiomC{\rA}\BinaryInfC{\rB}
\end{prooftree}
$$

Display prooftree:

$$
\begin{prooftree} \AxiomC{\rA\supset\rB} \AxiomC{\rA}
\RightLabel{{\supset}\text{elim}} \BinaryInfC{\rB}
\end{prooftree}
$$

Simple inline math: $x^2 + y^2 = z^2$ and display:

$$
E = mc^2
$$